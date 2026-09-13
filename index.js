const axios = require("axios");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const sharp = require("sharp");

const XOICHE = "https://xoiche.tv";
const PORT = process.env.PORT || 7001;
const PUBLIC_BASE_URL =
    process.env.RENDER_EXTERNAL_URL ||
    `http://127.0.0.1:${PORT}`;

const CACHE_TTL = 60 * 1000;

let catalogCache = {
    time: 0,
    metas: null
};

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
    "Accept":
        "application/json,text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language":
        "vi,en-US;q=0.9,en;q=0.8"
};

const builder = new addonBuilder({
    id: "community.xoiche",
    version: "1.3.0",
    name: "Xôi Chè Live",
    description: "Xem trực tiếp bóng đá từ Xôi Chè",
    resources: ["catalog", "meta", "stream"],
    types: ["movie"],
    catalogs: [
        {
            type: "movie",
            id: "xoiche-live",
            name: "Xôi Chè Live"
        }
    ],
    idPrefixes: ["xoiche:"]
});


async function getMatches() {
    const response = await axios.get(
        XOICHE + "/api/matches?filter=all",
        {
            headers: HEADERS,
            timeout: 20000
        }
    );

    const data = response.data;

    const matches = [
        ...(Array.isArray(data.live) ? data.live : []),
        ...(Array.isArray(data.spotlight) ? data.spotlight : []),
        ...(Array.isArray(data.scoreboard) ? data.scoreboard : [])
    ];

    const unique = [];
    const seen = new Set();

    for (const match of matches) {
        if (!match || match.sport !== "football") {
            continue;
        }

        if (!match.id || !match.slug) {
            continue;
        }

        if (seen.has(match.id)) {
            continue;
        }

        seen.add(match.id);

        const homeName = match.homeTeam?.name || "";
        const awayName = match.awayTeam?.name || "";

        if (!homeName || !awayName) {
            continue;
        }

        const kickoff = new Date(match.kickoffAt);

        const kickoffTime = kickoff.toLocaleTimeString(
            "vi-VN",
            {
                timeZone: "Asia/Ho_Chi_Minh",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false
            }
        );

        const kickoffDate = kickoff.toLocaleDateString(
            "vi-VN",
            {
                timeZone: "Asia/Ho_Chi_Minh",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            }
        );

        unique.push({
            id: "xoiche:" + match.slug,
            type: "movie",

            name:
                homeName +
                " vs " +
                awayName,

            description:
                homeName +
                " vs " +
                awayName +
                "\n" +
                "Giờ đá: " +
                kickoffTime +
                " - " +
                kickoffDate,

            releaseInfo: match.kickoffAt,

            website:
                XOICHE +
                "/tran-dau/" +
                encodeURIComponent(match.slug),

            homeLogo:
                match.homeTeam?.logoUrl || "",

            awayLogo:
                match.awayTeam?.logoUrl || "",

            kickoffAt: match.kickoffAt,

            competition:
                match.competition?.name || "",

            competitionLogo:
                match.competition?.logoUrl || "",

            poster:
                PUBLIC_BASE_URL +
                "/poster/" + encodeURIComponent(match.slug) + ".png"
        });
    }

    return unique;
}


async function getFixtureId(slug) {
    const url =
        XOICHE +
        "/tran-dau/" +
        encodeURIComponent(slug);

    const response = await axios.get(url, {
        headers: HEADERS,
        timeout: 20000
    });

    const html = response.data;

    const match = html.match(
        /\\"match\\":\{\\"id\\":\\"([0-9a-f-]{36})\\"[\s\S]*?\\"slug\\":\\"([^"]+)\\"/i
    );

    if (!match) {
        throw new Error("Không tìm thấy fixtureId");
    }

    return match[1];
}


async function getSources(slug) {
    const fixtureId = await getFixtureId(slug);

    const url =
        XOICHE +
        "/api/matches/" +
        encodeURIComponent(fixtureId) +
        "/sources";

    const response = await axios.get(url, {
        headers: {
            ...HEADERS,
            "Accept": "application/json"
        },
        timeout: 20000
    });

    return response.data;
}


function hasHls(sources) {
    if (sources?.mainChannel?.hlsUrl) {
        return true;
    }

    return (sources?.partnerRooms || []).some(
        room => !!room.hlsUrl
    );
}


async function hasRoom(match) {
    const slug =
        match.id.substring("xoiche:".length);

    try {
        const sources =
            await getSources(slug);

        if (hasHls(sources)) {
            console.log(
                "ROOM OK:",
                match.name
            );

            return match;
        }

        console.log(
            "NO ROOM:",
            match.name
        );

        return null;

    } catch (err) {

        console.log(
            "CHECK ERROR:",
            match.name,
            "-",
            err.message
        );

        return null;
    }
}


/*
 * EPL FILTER
 */
function filterEPL(matches) {

    const eplTeams = new Set([
        "Aston Villa",
        "Nottingham Forest",
        "Bournemouth",
        "Brentford",
        "Chelsea",
        "Hull City",
        "Crystal Palace",
        "Ipswich Town",
        "Liverpool",
        "Fulham",
        "Tottenham",
        "Everton",
        "Sunderland",
        "Arsenal",
        "Coventry City",
        "Brighton & Hove Albion",
        "Manchester United",
        "Manchester City",
        "Leeds United",
        "Newcastle United"
    ]);

    return matches.filter(match => {

        const home =
            match.description
                .split(" vs ")[0]
                .trim();

        const away =
            match.description
                .split(" vs ")[1]
                ?.split("\n")[0]
                ?.trim();

        return (
            eplTeams.has(home) &&
            eplTeams.has(away)
        );
    });
}


/*
 * CATALOG
 */
builder.defineCatalogHandler(
    async ({ type, id }) => {

        console.log(
            "Catalog request:",
            type + "/" + id
        );

        if (
            type !== "movie" ||
            id !== "xoiche-live"
        ) {
            return {
                metas: []
            };
        }

        if (
            catalogCache.metas &&
            Date.now() - catalogCache.time <
                CACHE_TTL
        ) {

            console.log(
                "Catalog cache HIT"
            );

            return {
                metas: catalogCache.metas
            };
        }

        console.log(
            "Catalog cache MISS"
        );

        try {

            const matches =
                await getMatches();

            const results =
                filterEPL(matches);

            results.sort(
                (a, b) =>
                    new Date(a.kickoffAt) -
                    new Date(b.kickoffAt)
            );

            console.log(
                "All football matches:",
                matches.length
            );

            console.log(
                "EPL matches:",
                results.length
            );

            for (
                const match of results
            ) {

                console.log(
                    "EPL:",
                    match.name,
                    "|",
                    match.description
                );
            }

            catalogCache = {
                time: Date.now(),
                metas: results
            };

            console.log(
                "Catalog cache UPDATED"
            );

            return {
                metas: results
            };

        } catch (err) {

            console.log(
                "Catalog error:",
                err.message
            );

            return {
                metas: []
            };
        }
    }
);


/*
 * META
 */
builder.defineMetaHandler(
    async ({ id }) => {

        const slug =
            id.substring("xoiche:".length);

        const matches =
            await getMatches();

        const found =
            matches.find(
                m => m.id === id
            );

        return {
            meta:
                found ||
                {
                    id,
                    type: "movie",
                    name: slug
                }
        };
    }
);


/*
 * POSTER
 *
 * Không gọi HLS.
 * Chỉ lấy thông tin trận + logo.
 */
async function createPosterSVG(slug) {

    let match = null;

    if (catalogCache.metas) {

        match =
            catalogCache.metas.find(
                m =>
                    m.id ===
                    "xoiche:" + slug
            );
    }

    if (!match) {

        const matches =
            await getMatches();

        match =
            matches.find(
                m =>
                    m.id ===
                    "xoiche:" + slug
            );
    }

    if (!match) {
        return null;
    }

    const homeName =
        match.name
            .split(" vs ")[0]
            .trim();

    const awayName =
        match.name
            .split(" vs ")[1]
            .trim();

    const kickoff =
        new Date(match.kickoffAt);

    const kickoffTime =
        kickoff.toLocaleTimeString(
            "vi-VN",
            {
                timeZone:
                    "Asia/Ho_Chi_Minh",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false
            }
        );

    const kickoffDate =
        kickoff.toLocaleDateString(
            "vi-VN",
            {
                timeZone:
                    "Asia/Ho_Chi_Minh",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            }
        );

    const escapeXml = value =>
        String(value || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");

    const homeLogoResponse =
        await axios.get(
            match.homeLogo,
            {
                responseType: "arraybuffer"
            }
        );

    const awayLogoResponse =
        await axios.get(
            match.awayLogo,
            {
                responseType: "arraybuffer"
            }
        );

    const homeLogo =
        "data:image/png;base64," +
        Buffer
            .from(homeLogoResponse.data)
            .toString("base64");

    const awayLogo =
        "data:image/png;base64," +
        Buffer
            .from(awayLogoResponse.data)
            .toString("base64");

    const home =
        escapeXml(homeName);

    const away =
        escapeXml(awayName);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="600"
     height="900"
     viewBox="0 0 600 900">

    <defs>

        <linearGradient
            id="bg"
            x1="0"
            y1="0"
            x2="1"
            y2="1">

            <stop
                offset="0%"
                stop-color="#101828"/>

            <stop
                offset="100%"
                stop-color="#172554"/>

        </linearGradient>

    </defs>

    <rect
        width="600"
        height="900"
        fill="url(#bg)"/>

    <text
        x="300"
        y="75"
        text-anchor="middle"
        fill="white"
        font-family="Arial, sans-serif"
        font-size="30"
        font-weight="bold">

        XÔI CHÈ LIVE

    </text>

    <text
        x="300"
        y="120"
        text-anchor="middle"
        fill="#cbd5e1"
        font-family="Arial, sans-serif"
        font-size="20">

        PREMIER LEAGUE

    </text>

    <circle
        cx="190"
        cy="315"
        r="125"
        fill="white"
        opacity="0.96"/>

    <circle
        cx="410"
        cy="315"
        r="125"
        fill="white"
        opacity="0.96"/>

    <image
        x="90"
        y="215"
        width="200"
        height="200"
        preserveAspectRatio="xMidYMid meet"
        href="${homeLogo}"
        xlink:href="${homeLogo}"/>

    <image
        x="310"
        y="215"
        width="200"
        height="200"
        preserveAspectRatio="xMidYMid meet"
        href="${awayLogo}"
        xlink:href="${awayLogo}"/>

    <text
        x="190"
        y="490"
        text-anchor="middle"
        fill="white"
        font-family="Arial, sans-serif"
        font-size="25"
        font-weight="bold">

        ${home}

    </text>

    <text
        x="410"
        y="490"
        text-anchor="middle"
        fill="white"
        font-family="Arial, sans-serif"
        font-size="25"
        font-weight="bold">

        ${away}

    </text>

    <text
        x="300"
        y="365"
        text-anchor="middle"
        fill="#facc15"
        font-family="Arial, sans-serif"
        font-size="42"
        font-weight="bold">

        VS

    </text>

    <text
        x="300"
        y="610"
        text-anchor="middle"
        fill="white"
        font-family="Arial, sans-serif"
        font-size="48"
        font-weight="bold">

        ${kickoffTime}

    </text>

    <text
        x="300"
        y="655"
        text-anchor="middle"
        fill="#cbd5e1"
        font-family="Arial, sans-serif"
        font-size="25">

        ${kickoffDate}

    </text>

    <rect
        x="80"
        y="730"
        width="440"
        height="2"
        fill="#475569"/>

    <text
        x="300"
        y="785"
        text-anchor="middle"
        fill="#94a3b8"
        font-family="Arial, sans-serif"
        font-size="20">

        Xem trực tiếp bóng đá

    </text>

</svg>`;

    return await sharp(
        Buffer.from(svg)
    )
        .png()
        .toBuffer();
}


/*
 * STREAM / HLS
 *
 * GIỮ NGUYÊN LOGIC CŨ
 */
builder.defineStreamHandler(
    async ({ type, id }) => {

        console.log(
            "Stream request:",
            type + "/" + id
        );

        if (
            type !== "movie" ||
            !id.startsWith("xoiche:")
        ) {
            return {
                streams: []
            };
        }

        const slug =
            id.substring(
                "xoiche:".length
            );

        try {

            const sources =
                await getSources(slug);

            const streams = [];

            if (
                sources.mainChannel?.hlsUrl
            ) {

                streams.push({
                    name:
                        "Xôi Chè - Main",

                    title:
                        "Main Channel",

                    url:
                        sources.mainChannel.hlsUrl
                });
            }

            for (
                const room
                of sources.partnerRooms || []
            ) {

                if (!room.hlsUrl) {
                    continue;
                }

                streams.push({
                    name:
                        "Xôi Chè - " +
                        (room.name || "BLV"),

                    title:
                        "BLV " +
                        (room.name || ""),

                    url:
                        room.hlsUrl
                });
            }

            const unique = [];
            const seen = new Set();

            for (
                const stream
                of streams
            ) {

                if (
                    !seen.has(stream.url)
                ) {

                    seen.add(
                        stream.url
                    );

                    unique.push(
                        stream
                    );
                }
            }

            console.log(
                "Found HLS streams:",
                unique.length
            );

            return {
                streams: unique
            };

        } catch (err) {

            console.log(
                "Stream error:",
                err.message
            );

            return {
                streams: []
            };
        }
    }
);


/*
 * EXPRESS SERVER
 */
const app = express();

const addonRouter =
    getRouter(
        builder.getInterface()
    );

app.get(
    "/poster/:slug.png",
    async (req, res) => {

        try {

            const png = await createPosterSVG(
                    req.params.slug
                );

            if (!png) {

                return res
                    .status(404)
                    .send("Poster not found");
            }

            res.set(
                "Content-Type",
                "image/png"
            );

            res.set(
                "Cache-Control",
                "public, max-age=300"
            );

            res.send(png);

        } catch (err) {

            console.log(
                "Poster error:",
                err.message
            );

            res
                .status(500)
                .send("Poster error");
        }
    }
);

app.use(
    "/",
    addonRouter
);

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "Xôi Chè addon running on port " +
            PORT
        );

        console.log(
            "Public base URL:",
            PUBLIC_BASE_URL
        );

        console.log(
            "Manifest:",
            PUBLIC_BASE_URL +
            "/manifest.json"
        );
    }
);



