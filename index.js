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
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "vi,en-US;q=0.9,en;q=0.8"
};

const builder = new addonBuilder({
    id: "community.xoiche",
    version: "1.2.1",
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
    const response = await axios.get(XOICHE + "/", {
        headers: HEADERS,
        timeout: 20000
    });

    const html = response.data;
    const matches = [];

    const scripts =
        html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];

    for (const script of scripts) {
        const match = script.match(
            /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i
        );

        if (!match) continue;

        try {
            const data = JSON.parse(match[1]);

            if (
                data &&
                data["@type"] === "ItemList" &&
                Array.isArray(data.itemListElement)
            ) {
                for (const item of data.itemListElement) {
                    const event = item.item;

                    if (!event || event["@type"] !== "SportsEvent") continue;
                    if (event.sport !== "Football") continue;
                    if (!event.url || !event.name) continue;

                    const slug = event.url.split("/tran-dau/").pop();

                    matches.push({
                        id: "xoiche:" + slug,
                        type: "movie",
                        name: event.name,
                        description:
                            (event.homeTeam?.name || "") +
                            " vs " +
                            (event.awayTeam?.name || "") +
                            "\n" +
                            new Date(event.startDate).toLocaleString("vi-VN", {
                                timeZone: "Asia/Ho_Chi_Minh"
                            }),
                        releaseInfo: event.startDate,
                        website: event.url
                    });
                }
            }
        } catch (e) {
            console.log("JSON-LD parse error:", e.message);
        }
    }

    const unique = [];
    const seen = new Set();

    for (const match of matches) {
        if (!seen.has(match.id)) {
            seen.add(match.id);
            unique.push(match);
        }
    }

    return unique;
}

async function getFixtureId(slug) {
    const url = XOICHE + "/tran-dau/" + encodeURIComponent(slug);

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

    return (sources?.partnerRooms || []).some(room => !!room.hlsUrl);
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
        console.log("CHECK ERROR:", match.name, "-", err.message);
        return null;
    }
}

builder.defineCatalogHandler(async ({ type, id }) => {
    console.log("Catalog request:", type + "/" + id);

    if (type !== "movie" || id !== "xoiche-live") {
        return { metas: [] };
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

        console.log("Found football matches:", matches.length);
        console.log("Checking rooms...");

        const results = [];
        const batchSize = 5;

        for (let i = 0; i < matches.length; i += batchSize) {
            const batch = matches.slice(i, i + batchSize);
            const checked = await Promise.all(batch.map(hasRoom));

            for (const match of checked) {
                if (match) {
                    results.push(match);
                }
            }
        }

        console.log("Matches with HLS:", results.length);

        catalogCache = {
            time: Date.now(),
            metas: results
        };

        console.log("Catalog cache UPDATED");

        return {
            metas: results
        };
    } catch (err) {
        console.log("Catalog error:", err.message);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async ({ id }) => { const slug = id.substring("xoiche:".length); const match = await getMatches(); const found = match.find(m => m.id === id); return { meta: found || { id, type: "movie", name: slug } }; });

builder.defineStreamHandler(async ({ type, id }) => {
    console.log("Stream request:", type + "/" + id);

    if (type !== "movie" || !id.startsWith("xoiche:")) {
        return { streams: [] };
    }

    const slug = id.substring("xoiche:".length);

    try {
        const sources = await getSources(slug);

        const streams = [];

        if (sources.mainChannel?.hlsUrl) {
            streams.push({
                name: "Xôi Chè - Main",
                title: "Main Channel",
                url: sources.mainChannel.hlsUrl
            });
        }

        for (const room of sources.partnerRooms || []) {
            if (!room.hlsUrl) continue;

            streams.push({
                name: "Xôi Chè - " + (room.name || "BLV"),
                title: "BLV " + (room.name || ""),
                url: room.hlsUrl
            });
        }

        const unique = [];
        const seen = new Set();

        for (const stream of streams) {
            if (!seen.has(stream.url)) {
                seen.add(stream.url);
                unique.push(stream);
            }
        }

        console.log("Found HLS streams:", unique.length);

        return {
            streams: unique
        };
    } catch (err) {
        console.log("Stream error:", err.message);
        return { streams: [] };
    }
});

serveHTTP(builder.getInterface(), {
    port: 7001
});

console.log("Xôi Chè addon running on http://localhost:7001");
console.log("Manifest: http://127.0.0.1:7001/manifest.json");

