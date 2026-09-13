const axios = require("axios");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const XOICHE = "https://xoiche.tv";
const CACHE_TTL = 60 * 1000;

let catalogCache = {
    time: 0,
    metas: null
};

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
    "Accept": "application/json,text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "vi,en-US;q=0.9,en;q=0.8"
};

const builder = new addonBuilder({
    id: "community.xoiche",
    version: "1.2.3",
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

    /*
     * Xôi Chè API trả về:
     * live
     * spotlight
     * scoreboard
     *
     * Gộp cả 3 nhóm để không bỏ sót trận.
     */
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

        const kickoffTime = kickoff.toLocaleTimeString("vi-VN", {
            timeZone: "Asia/Ho_Chi_Minh",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
        });

        const kickoffDate = kickoff.toLocaleDateString("vi-VN", {
            timeZone: "Asia/Ho_Chi_Minh",
            day: "2-digit",
            month: "2-digit",
            year: "numeric"
        });

        unique.push({
            id: "xoiche:" + match.slug,
            type: "movie",

            name: homeName + " vs " + awayName,

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

            homeLogo: match.homeTeam?.logoUrl || "",
            awayLogo: match.awayTeam?.logoUrl || "",

            kickoffAt: match.kickoffAt,

            competition: match.competition?.name || "",
            competitionLogo: match.competition?.logoUrl || ""
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
    const slug = match.id.substring("xoiche:".length);

    try {
        const sources = await getSources(slug);

        if (hasHls(sources)) {
            console.log("ROOM OK:", match.name);
            return match;
        }

        console.log("NO ROOM:", match.name);
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


builder.defineCatalogHandler(async ({ type, id }) => {
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
        Date.now() - catalogCache.time < CACHE_TTL
    ) {
        console.log("Catalog cache HIT");

        return {
            metas: catalogCache.metas
        };
    }

    console.log("Catalog cache MISS");

    try {
        const matches = await getMatches();

        /*
         * GIỮ NGUYÊN EPL FILTER
         */
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

        const results = matches.filter(match => {
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

        /*
         * Sắp xếp theo giờ đá
         */
        results.sort((a, b) => {
            return (
                new Date(a.kickoffAt) -
                new Date(b.kickoffAt)
            );
        });

        console.log(
            "All football matches:",
            matches.length
        );

        console.log(
            "EPL matches:",
            results.length
        );

        for (const match of results) {
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
});


builder.defineMetaHandler(async ({ id }) => {
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
});


/*
 * GIỮ NGUYÊN LOGIC HLS
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
            id.substring("xoiche:".length);

        try {
            const sources =
                await getSources(slug);

            const streams = [];

            if (
                sources.mainChannel?.hlsUrl
            ) {
                streams.push({
                    name: "Xôi Chè - Main",
                    title: "Main Channel",
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

                    url: room.hlsUrl
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
                    seen.add(stream.url);
                    unique.push(stream);
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


serveHTTP(
    builder.getInterface(),
    {
        port: 7001
    }
);

console.log(
    "Xôi Chè addon running on http://localhost:7001"
);

console.log(
    "Manifest: http://127.0.0.1:7001/manifest.json"
);
