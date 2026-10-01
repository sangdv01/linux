const axios = require("axios");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const sharp = require("sharp");

const XOICHE = "https://xoiche.tv";
const PORT = process.env.PORT || 7001;
const PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`;
const ACEHUB_LAN_HOST = process.env.ACEHUB_HOST || "172.31.99.78:8000";

/*
 * CACHE & LIMITS (Chống rò rỉ RAM trên VPS / Free Hosting)
 */
const MATCHES_CACHE_TTL = 3 * 60 * 1000; // 3 phút
const POSTER_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 giờ
const LOGO_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 giờ
const MAX_CACHE_ENTRIES = 100; // Giới hạn số lượng mục trong RAM

class SimpleLRUCache {
    constructor(max = 100, ttl = 3600000) {
        this.max = max;
        this.ttl = ttl;
        this.cache = new Map();
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() - item.time > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        // Đưa key lên đầu danh sách (LRU)
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.max) {
            // Xóa mục cũ nhất khi vượt ngưỡng
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, { time: Date.now(), value });
    }
}

const posterCache = new SimpleLRUCache(MAX_CACHE_ENTRIES, POSTER_CACHE_TTL);
const logoCache = new SimpleLRUCache(MAX_CACHE_ENTRIES, LOGO_CACHE_TTL);
const inFlightPosters = new Map(); // Tránh tạo trùng poster khi nhiều client request cùng lúc

let matchesCache = {
    time: 0,
    matches: [],
    slugToFixtureId: new Map()
};

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
    "Accept": "application/json,text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "vi,en-US;q=0.9,en;q=0.8"
};

// Formatter dùng chung giúp tối ưu tốc độ xử lý Date
const timeFormatter = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
});

const dateFormatter = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
});

/*
 * DANH SÁCH KÊNH THỂ THAO ACESTREAM ĐỘ PHÂN GIẢI CAO (FHD 50FPS)
 */
const ACESTREAM_CHANNELS = [
    {
        id: "acehub:laliga",
        name: "M. LaLiga HD",
        title: "Movistar LaLiga (Bóng Đá Tây Ban Nha 1080p)",
        genres: ["Bóng Đá", "Kênh Thể Thao 24/7"],
        infohash: "c1959a27edb0b94c5005a2dea93b7a70d4312f1c",
        country: "ES",
        language: "Tây Ban Nha",
        resolution: "1080p 50fps",
        description: "Kênh phát sóng trực tiếp giải VĐQG Tây Ban Nha (La Liga) độ phân giải Full HD 1080p 50fps mượt mà qua trạm phát aceHub."
    },
    {
        id: "acehub:skysports-pl",
        name: "Sky Sports Premier League HD",
        title: "Sky Sports Premier League (Ngoại Hạng Anh 1080p)",
        genres: ["Bóng Đá", "Kênh Thể Thao 24/7"],
        infohash: "78266c15035d0ad8cbc58f821733931e1de434ab",
        country: "UK",
        language: "Tiếng Anh",
        resolution: "1080p 50fps",
        description: "Kênh chuyên biệt phát sóng trọn vẹn giải Ngoại Hạng Anh (English Premier League) từ đài Sky Sports UK chuẩn 1080p 50fps."
    },
    {
        id: "acehub:skysports-main",
        name: "Sky Sports Main Event HD",
        title: "Sky Sports Main Event (Thể Thao Đỉnh Cao)",
        genres: ["Bóng Đá", "Kênh Thể Thao 24/7"],
        infohash: "78266c15035d0ad8cbc58f821733931e1de434ab",
        country: "UK",
        language: "Tiếng Anh",
        resolution: "1080p 50fps",
        description: "Kênh sự kiện thể thao chính của Sky Sports phát sóng các trận cầu đinh và sự kiện thể thao lớn nhất trong tuần."
    },
    {
        id: "acehub:canal-sport2",
        name: "Canal+ Sport 2 HD",
        title: "Canal+ Sport 2 (Bóng Đá Châu Âu 1080p)",
        genres: ["Bóng Đá", "Kênh Thể Thao 24/7"],
        infohash: "9bd91396b4418ae7c8eed7b8a6964eb8a43de204",
        country: "PL",
        language: "Châu Âu",
        resolution: "1080p 50fps",
        description: "Kênh thể thao Canal+ phát sóng các giải bóng đá hàng đầu châu Âu (Champions League, Europa League, Ngoại Hạng Anh)."
    },
    {
        id: "acehub:polsat-prem1",
        name: "Polsat Sport Premium 1 HD",
        title: "Polsat Sport Premium 1 (Bitrate Siêu Cao > 2000 Kbps)",
        genres: ["Bóng Đá", "Kênh Thể Thao 24/7"],
        infohash: "58b193890946b099a7d2c7dca37a48b36a12467f",
        country: "PL",
        language: "Châu Âu",
        resolution: "1080p 50fps (Super Bitrate)",
        description: "Kênh truyền hình thể thao chất lượng siêu cao với bitrate cực lớn, hình ảnh chi tiết và sắc nét vượt trội."
    },
    {
        id: "acehub:polsat-extra",
        name: "Polsat Sport Extra HD",
        title: "Polsat Sport Extra (Bóng Đá & Thể Thao Châu Âu)",
        genres: ["Bóng Đá", "Kênh Thể Thao 24/7"],
        infohash: "f0beebc90853dc8342691a85539b5efbe0e94c1e",
        country: "PL",
        language: "Châu Âu",
        resolution: "1080p 50fps",
        description: "Kênh tiếp sóng bóng đá và các sự kiện thể thao châu Âu đài Polsat Sport."
    },
    {
        id: "acehub:deportes2",
        name: "M. Deportes 2 HD",
        title: "Movistar Deportes 2 (Thể Thao Tổng Hợp)",
        genres: ["Kênh Thể Thao 24/7"],
        infohash: "a0fd9380808627dc9dd061348caa6065e7b6037a",
        country: "ES",
        language: "Tây Ban Nha",
        resolution: "1080p",
        description: "Kênh thể thao tổng hợp của Movistar Tây Ban Nha (Bóng rổ, bóng đá, đua xe, tennis)."
    },
    {
        id: "acehub:eurosport1",
        name: "Eurosport 1 HD",
        title: "Eurosport 1 HD (Quần Vợt & Thể Thao Quốc Tế)",
        genres: ["Quần Vợt", "Kênh Thể Thao 24/7"],
        infohash: "42e959bffd0dd0f138dd03abf387b4284ece7e30",
        country: "EU",
        language: "Quốc Tế",
        resolution: "1080p 50fps",
        description: "Kênh thể thao số 1 châu Âu phát sóng trực tiếp Grand Slam Tennis, đua xe đạp Tour de France, Olympic và giải đấu thể thao."
    },
    {
        id: "acehub:tennis-channel",
        name: "Tennis Channel HD",
        title: "Tennis Channel HD (Chuyên Biệt Quần Vợt)",
        genres: ["Quần Vợt", "Kênh Thể Thao 24/7"],
        infohash: "1b348443efc7f0cf4cdf349ac35bbe5d41be6220",
        country: "US",
        language: "Tiếng Anh",
        resolution: "1080p",
        description: "Kênh truyền hình chuyên biệt về môn quần vợt thế giới (ATP, WTA, Grand Slam)."
    },
    {
        id: "acehub:skysports-arena",
        name: "Sky Sports Arena HD",
        title: "Sky Sports Arena (Quyền Anh, Bóng Rổ & Thể Thao)",
        genres: ["Kênh Thể Thao 24/7"],
        infohash: "37796ca47026bc190c7dc26827c0dfb6b61d137b",
        country: "UK",
        language: "Tiếng Anh",
        resolution: "1080p 50fps",
        description: "Kênh phát sóng các sự kiện thể thao đặc sắc: Quyền Anh (Boxing), Bóng bầu dục, Bóng rổ NBA và Darts."
    },
    {
        id: "acehub:foxsports2",
        name: "FOX Sports 2 HD",
        title: "FOX Sports 2 HD (Thể Thao Mỹ)",
        genres: ["Kênh Thể Thao 24/7"],
        infohash: "e765303108614af0f9a42da7b45a147195982796",
        country: "US",
        language: "Tiếng Anh",
        resolution: "1080p",
        description: "Kênh thể thao tổng hợp đài FOX Sports (Bóng đá quốc tế, bóng rổ đại học NCAA, đua xe NASCAR)."
    },
    {
        id: "acehub:rtl-sport1",
        name: "RTL+ Sport Event 1 HD",
        title: "RTL+ Sport Event 1 (Bóng Đá & Đua Xe)",
        genres: ["Tốc Độ & Khác", "Bóng Đá"],
        infohash: "d447e74caac94ffe252aaf7e5c3f88779ea7bb3b",
        country: "DE",
        language: "Đức",
        resolution: "1080p 50fps",
        description: "Kênh phát sóng sự kiện thể thao trực tiếp đài RTL+ (Europa League, Đua xe Motorsport)."
    }
];

function getAceHubMetas(genre) {
    let list = ACESTREAM_CHANNELS;
    if (genre && genre !== "Tất cả") {
        list = list.filter(c => c.genres.includes(genre));
    }
    return list.map(c => ({
        id: c.id,
        type: "sports",
        name: c.name,
        genres: c.genres,
        poster: `${PUBLIC_BASE_URL}/poster/acehub/${encodeURIComponent(c.id.replace("acehub:", ""))}.png`,
        posterShape: "poster",
        banner: `${PUBLIC_BASE_URL}/poster/acehub/${encodeURIComponent(c.id.replace("acehub:", ""))}.png`,
        background: `${PUBLIC_BASE_URL}/poster/acehub/${encodeURIComponent(c.id.replace("acehub:", ""))}.png`,
        description: `${c.title}\n\n• Độ phân giải: ${c.resolution}\n• Quốc gia: ${c.country} (${c.language})\n• Công nghệ: AceStream P2P 0-Transcode qua trạm phát aceHub\n\n${c.description}`,
        releaseInfo: c.resolution
    }));
}

/*
 * MANIFEST BUILDER
 */
const builder = new addonBuilder({
    id: "community.xoiche",
    version: "1.5.0",
    name: "Xôi Chè Live",
    description: "Xem trực tiếp Ngoại Hạng Anh & Thể Thao AceStream FHD",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "sports", "tv"],
    catalogs: [
        {
            type: "movie",
            id: "xoiche-live",
            name: "Xôi Chè Live (EPL & Chelsea)"
        },
        {
            type: "sports",
            id: "xoiche-live-sports",
            name: "Xôi Chè Live (EPL & Chelsea)"
        },
        {
            type: "sports",
            id: "acehub-sports",
            name: "Thể Thao - AceStream FHD",
            extra: [
                {
                    name: "genre",
                    options: ["Tất cả", "Bóng Đá", "Kênh Thể Thao 24/7", "Quần Vợt", "Tốc Độ & Khác"],
                    isRequired: false
                }
            ]
        }
    ],
    idPrefixes: ["xoiche:", "acehub:"]
});

/*
 * LẤY TẤT CẢ TRẬN ĐẤU TỪ API (CÓ CACHE VÀ LƯU FIXTURE ID)
 */
async function getRawMatches() {
    if (matchesCache.matches.length > 0 && Date.now() - matchesCache.time < MATCHES_CACHE_TTL) {
        return matchesCache;
    }

    const response = await axios.get(`${XOICHE}/api/matches?filter=all`, {
        headers: HEADERS,
        timeout: 10000
    });

    const data = response.data || {};
    const rawMatches = [
        ...(Array.isArray(data.live) ? data.live : []),
        ...(Array.isArray(data.spotlight) ? data.spotlight : []),
        ...(Array.isArray(data.scoreboard) ? data.scoreboard : []),
        ...(Array.isArray(data.pinned) ? data.pinned : [])
    ];

    const unique = [];
    const seen = new Set();
    const slugMap = new Map();

    for (const match of rawMatches) {
        if (!match || match.sport !== "football" || !match.id || !match.slug) continue;
        if (seen.has(match.id)) continue;
        seen.add(match.id);

        // Lưu fixtureId (UUID) theo slug để dùng ngay khi xem stream, không cần tải lại HTML
        slugMap.set(match.slug, match.id);

        const homeName = match.homeTeam?.name || "";
        const awayName = match.awayTeam?.name || "";
        if (!homeName || !awayName) continue;

        const kickoff = new Date(match.kickoffAt);
        const kickoffTime = timeFormatter.format(kickoff);
        const kickoffDate = dateFormatter.format(kickoff);

        unique.push({
            id: `xoiche:${match.slug}`,
            type: "movie",
            name: `${homeName} vs ${awayName}`,
            homeName,
            awayName,
            description: `${homeName} vs ${awayName}\nGiải đấu: ${match.competition?.name || "Bóng đá"}\nGiờ đá: ${kickoffTime} - ${kickoffDate}`,
            releaseInfo: match.kickoffAt,
            website: `${XOICHE}/tran-dau/${encodeURIComponent(match.slug)}`,
            homeLogo: match.homeTeam?.logoUrl || "",
            awayLogo: match.awayTeam?.logoUrl || "",
            kickoffAt: match.kickoffAt,
            competition: match.competition?.name || "",
            competitionSlug: match.competition?.slug || "",
            competitionLogo: match.competition?.logoUrl || "",
            poster: `${PUBLIC_BASE_URL}/poster/${encodeURIComponent(match.slug)}.png`
        });
    }

    matchesCache = {
        time: Date.now(),
        matches: unique,
        slugToFixtureId: slugMap
    };

    return matchesCache;
}

/*
 * FILTER: PREMIER LEAGUE (EPL) HOẶC CÓ ĐỘI CHELSEA ĐÁ Ở BẤT KỲ GIẢI NÀO
 */
function filterMatches(matches) {
    return matches.filter(match => {
        const compSlug = (match.competitionSlug || "").toLowerCase();
        const compName = (match.competition || "").toLowerCase();
        const isEpl = compSlug.includes("premier-league") || compName.includes("premier league");

        const home = (match.homeName || "").toLowerCase();
        const away = (match.awayName || "").toLowerCase();
        const isChelsea = home.includes("chelsea") || away.includes("chelsea");

        return isEpl || isChelsea;
    });
}

/*
 * CATALOG HANDLER
 */
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    // 1. Catalog AceStream Thể Thao FHD
    if (type === "sports" && id === "acehub-sports") {
        const genre = extra?.genre || "Tất cả";
        return { metas: getAceHubMetas(genre) };
    }

    // 2. Catalog Xôi Chè trong mục Sports
    if (type === "sports" && id === "xoiche-live-sports") {
        try {
            const { matches } = await getRawMatches();
            const filtered = filterMatches(matches);
            filtered.sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
            return { metas: filtered.map(m => ({ ...m, type: "sports" })) };
        } catch (err) {
            console.error("Catalog error:", err.message);
            return { metas: (matchesCache.matches || []).map(m => ({ ...m, type: "sports" })) };
        }
    }

    // 3. Catalog Xôi Chè trong mục Movies (tương thích ngược)
    if (type === "movie" && id === "xoiche-live") {
        try {
            const { matches } = await getRawMatches();
            const filtered = filterMatches(matches);
            filtered.sort((a, b) => new Date(a.kickoffAt) - new Date(b.kickoffAt));
            return { metas: filtered };
        } catch (err) {
            console.error("Catalog error:", err.message);
            return { metas: filterMatches(matchesCache.matches || []) };
        }
    }

    return { metas: [] };
});

/*
 * META HANDLER
 */
builder.defineMetaHandler(async ({ type, id }) => {
    // 1. Kênh AceStream
    if (id.startsWith("acehub:")) {
        const metas = getAceHubMetas("Tất cả");
        const found = metas.find(m => m.id === id);
        if (found) return { meta: found };
        return { meta: { id, type: type || "sports", name: "AceStream Channel" } };
    }

    // 2. Trận đấu Xôi Chè
    const slug = id.replace("xoiche:", "");
    try {
        const { matches } = await getRawMatches();
        const found = matches.find(m => m.id === id);
        return {
            meta: found || { id, type: type || "movie", name: slug }
        };
    } catch (err) {
        return { meta: { id, type: type || "movie", name: slug } };
    }
});

/*
 * TẢI LOGO (CÓ TIMEOUT & ERROR FALLBACK)
 */
async function getLogoDataUri(url) {
    if (!url) return "";
    const cached = logoCache.get(url);
    if (cached) return cached;

    try {
        const response = await axios.get(url, {
            responseType: "arraybuffer",
            headers: HEADERS,
            timeout: 5000 // 5s timeout để tránh làm chậm poster
        });
        const contentType = response.headers["content-type"] || "image/png";
        const dataUri = `data:${contentType};base64,${Buffer.from(response.data).toString("base64")}`;
        logoCache.set(url, dataUri);
        return dataUri;
    } catch (e) {
        return ""; // Fallback nếu tải logo thất bại
    }
}

/*
 * TẠO POSTER DẠNG PNG CHO KÊNH ACEHUB
 */
async function createAceHubPosterPNG(channelId) {
    const fullId = `acehub:${channelId}`;
    const channel = ACESTREAM_CHANNELS.find(c => c.id === fullId);
    if (!channel) return null;

    const cached = posterCache.get(fullId);
    if (cached) return cached;

    const escapeXml = str => String(str || "").replace(/[<>&"']/g, c => ({
        "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"
    }[c]));

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
    <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#090d16"/>
            <stop offset="60%" stop-color="#0f172a"/>
            <stop offset="100%" stop-color="#1e1b4b"/>
        </linearGradient>
        <linearGradient id="badgeGlow" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#22c55e"/>
            <stop offset="100%" stop-color="#38bdf8"/>
        </linearGradient>
    </defs>
    <rect width="600" height="900" fill="url(#bg)"/>
    
    <!-- Header Badge -->
    <rect x="175" y="60" width="250" height="38" rx="19" fill="#1e293b" stroke="#334155" stroke-width="2"/>
    <text x="300" y="85" text-anchor="middle" fill="#38bdf8" font-family="Arial, sans-serif" font-size="16" font-weight="bold" letter-spacing="1">ACESTREAM LIVE</text>
    
    <!-- Central Icon Card -->
    <rect x="80" y="150" width="440" height="350" rx="24" fill="#131c31" stroke="#1e293b" stroke-width="2"/>
    <circle cx="300" cy="290" r="85" fill="#090d16" stroke="url(#badgeGlow)" stroke-width="4"/>
    
    <!-- Play Icon Triangle -->
    <polygon points="280,250 280,330 345,290" fill="#22c55e"/>

    <!-- Quality Tag inside Card -->
    <rect x="180" y="415" width="240" height="42" rx="21" fill="url(#badgeGlow)"/>
    <text x="300" y="442" text-anchor="middle" fill="#090d16" font-family="Arial, sans-serif" font-size="18" font-weight="bold">${escapeXml(channel.resolution)}</text>

    <!-- Channel Name -->
    <text x="300" y="580" text-anchor="middle" fill="#f8fafc" font-family="Arial, sans-serif" font-size="30" font-weight="bold">${escapeXml(channel.name)}</text>
    <text x="300" y="625" text-anchor="middle" fill="#94a3b8" font-family="Arial, sans-serif" font-size="20">${escapeXml(channel.country + ' • ' + channel.language)}</text>

    <!-- Divider Line -->
    <line x1="80" y1="680" x2="520" y2="680" stroke="#334155" stroke-width="2"/>

    <!-- Footer Tags -->
    <text x="300" y="735" text-anchor="middle" fill="#38bdf8" font-family="Arial, sans-serif" font-size="22" font-weight="bold">TRẠM PHÁT ACEHUB</text>
    <text x="300" y="780" text-anchor="middle" fill="#64748b" font-family="Arial, sans-serif" font-size="16">0-Transcode P2P • VIP Auth 0 Ads</text>
</svg>`;

    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    posterCache.set(fullId, png);
    return png;
}

/*
 * TẠO POSTER DẠNG PNG CHO TRẬN ĐẤU XÔI CHÈ
 */
async function createPosterPNG(slug) {
    const cached = posterCache.get(slug);
    if (cached) return cached;

    // In-flight deduplication: nếu đang có request xử lý poster này thì đợi chung
    if (inFlightPosters.has(slug)) {
        return inFlightPosters.get(slug);
    }

    const task = (async () => {
        try {
            const { matches } = await getRawMatches();
            const match = matches.find(m => m.id === `xoiche:${slug}`);
            if (!match) return null;

            const homeName = match.homeName || "";
            const awayName = match.awayName || "";
            const kickoff = new Date(match.kickoffAt);
            const kickoffTime = timeFormatter.format(kickoff);
            const kickoffDate = dateFormatter.format(kickoff);

            const escapeXml = str => String(str || "").replace(/[<>&"']/g, c => ({
                "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"
            }[c]));

            // Tải 2 logo song song
            const [homeLogo, awayLogo] = await Promise.all([
                getLogoDataUri(match.homeLogo),
                getLogoDataUri(match.awayLogo)
            ]);

            const compDisplay = (match.competition || "BÓNG ĐÁ").toUpperCase();
            const compFontSize = compDisplay.length > 32 ? 16 : (compDisplay.length > 22 ? 18 : 20);

            const getTeamFontSize = name => {
                if (name.length > 20) return 17;
                if (name.length > 15) return 20;
                return 24;
            };

            const homeFontSize = getTeamFontSize(homeName);
            const awayFontSize = getTeamFontSize(awayName);

            const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="900" viewBox="0 0 600 900">
    <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#101828"/>
            <stop offset="100%" stop-color="#172554"/>
        </linearGradient>
    </defs>
    <rect width="600" height="900" fill="url(#bg)"/>
    <text x="300" y="75" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="30" font-weight="bold">XÔI CHÈ LIVE</text>
    <text x="300" y="120" text-anchor="middle" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="${compFontSize}">${escapeXml(compDisplay)}</text>
    
    <circle cx="190" cy="315" r="125" fill="white" opacity="0.96"/>
    <circle cx="410" cy="315" r="125" fill="white" opacity="0.96"/>
    
    ${homeLogo ? `<image x="90" y="215" width="200" height="200" preserveAspectRatio="xMidYMid meet" href="${homeLogo}"/>` : ""}
    ${awayLogo ? `<image x="310" y="215" width="200" height="200" preserveAspectRatio="xMidYMid meet" href="${awayLogo}"/>` : ""}

    <text x="190" y="490" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="${homeFontSize}" font-weight="bold">${escapeXml(homeName)}</text>
    <text x="410" y="490" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="${awayFontSize}" font-weight="bold">${escapeXml(awayName)}</text>
    <text x="300" y="365" text-anchor="middle" fill="#facc15" font-family="Arial, sans-serif" font-size="42" font-weight="bold">VS</text>
    <text x="300" y="610" text-anchor="middle" fill="white" font-family="Arial, sans-serif" font-size="48" font-weight="bold">${kickoffTime}</text>
    <text x="300" y="655" text-anchor="middle" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="25">${kickoffDate}</text>
    <rect x="80" y="730" width="440" height="2" fill="#475569"/>
    <text x="300" y="785" text-anchor="middle" fill="#94a3b8" font-family="Arial, sans-serif" font-size="20">Xem trực tiếp bóng đá</text>
</svg>`;

            const png = await sharp(Buffer.from(svg)).png().toBuffer();
            posterCache.set(slug, png);
            return png;
        } finally {
            inFlightPosters.delete(slug);
        }
    })();

    inFlightPosters.set(slug, task);
    return task;
}

/*
 * LẤY NGUỒN PHÁT (STREAM SOURCES)
 * Ưu tiên fixtureId đã lưu trong RAM, chỉ cào HTML khi không tìm thấy
 */
async function getSources(slug) {
    let fixtureId = matchesCache.slugToFixtureId.get(slug);

    if (!fixtureId) {
        const { slugToFixtureId } = await getRawMatches();
        fixtureId = slugToFixtureId.get(slug);
    }

    // Fallback: cào HTML nếu API không còn trận này
    if (!fixtureId) {
        try {
            const pageRes = await axios.get(`${XOICHE}/tran-dau/${encodeURIComponent(slug)}`, {
                headers: HEADERS,
                timeout: 10000
            });
            const m = pageRes.data.match(/\\"match\\":\{\\"id\\":\\"([0-9a-f-]{36})\\"/i);
            if (m) fixtureId = m[1];
        } catch (e) {
            console.error("HTML scrape fallback failed:", e.message);
        }
    }

    if (!fixtureId) {
        throw new Error(`Không tìm thấy fixtureId cho trận: ${slug}`);
    }

    const response = await axios.get(`${XOICHE}/api/matches/${encodeURIComponent(fixtureId)}/sources`, {
        headers: { ...HEADERS, "Accept": "application/json" },
        timeout: 10000
    });
    return response.data;
}

/*
 * STREAM HANDLER
 */
builder.defineStreamHandler(async ({ type, id }) => {
    // 1. Kênh Thể Thao AceStream (acehub:)
    if (id.startsWith("acehub:")) {
        const channel = ACESTREAM_CHANNELS.find(c => c.id === id);
        const infohash = channel ? channel.infohash : id.replace("acehub:", "");
        const name = channel ? channel.name : "Kênh Thể Thao";
        return {
            streams: [
                {
                    name: "AceHub LAN [TV / Điện Thoại]",
                    title: `⚡ ${name} [1080p 50fps]\nTrạm phát: http://${ACEHUB_LAN_HOST}\nDành cho Smart TV / Apple TV cùng mạng Wi-Fi`,
                    url: `http://${ACEHUB_LAN_HOST}/live?id=${infohash}`
                },
                {
                    name: "AceHub Local [Máy Tính]",
                    title: `💻 ${name} [1080p 50fps]\nTrạm phát: http://127.0.0.1:8000\nDành cho Stremio trên PC`,
                    url: `http://127.0.0.1:8000/live?id=${infohash}`
                }
            ]
        };
    }

    // 2. Trận đấu Xôi Chè (xoiche:)
    if (id.startsWith("xoiche:")) {
        const slug = id.replace("xoiche:", "");
        try {
            const sources = await getSources(slug);
            const streams = [];

            // Luồng AceStream FHD kèm theo
            streams.push({
                name: "AceHub [1080p 50fps]",
                title: `⚽ [AceStream FHD] Sky Sports Premier League\nTrạm phát LAN: http://${ACEHUB_LAN_HOST}`,
                url: `http://${ACEHUB_LAN_HOST}/live?id=78266c15035d0ad8cbc58f821733931e1de434ab`
            });

            if (sources?.mainChannel?.hlsUrl) {
                streams.push({
                    name: "Xôi Chè - Main",
                    title: "Main Channel (BLV Tiếng Việt)",
                    url: sources.mainChannel.hlsUrl
                });
            }

            for (const room of sources?.partnerRooms || []) {
                if (!room.hlsUrl) continue;
                streams.push({
                    name: `Xôi Chè - ${room.name || "BLV"}`,
                    title: `BLV ${room.name || ""}`.trim(),
                    url: room.hlsUrl
                });
            }

            // Loại bỏ link stream trùng lặp
            const unique = [];
            const seen = new Set();
            for (const stream of streams) {
                if (!seen.has(stream.url)) {
                    seen.add(stream.url);
                    unique.push(stream);
                }
            }
            return { streams: unique };
        } catch (err) {
            console.error("Stream error:", err.message);
            return { streams: [] };
        }
    }

    return { streams: [] };
});

/*
 * EXPRESS SERVER
 */
const app = express();

// Poster trận đấu Xôi Chè
app.get("/poster/:slug.png", async (req, res) => {
    try {
        const png = await createPosterPNG(req.params.slug);
        if (!png) return res.status(404).send("Poster not found");

        res.set({
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*"
        });
        res.send(png);
    } catch (err) {
        console.error("Poster error:", err.message);
        res.status(500).send("Poster error");
    }
});

// Poster kênh AceStream
app.get("/poster/acehub/:id.png", async (req, res) => {
    try {
        const png = await createAceHubPosterPNG(req.params.id);
        if (!png) return res.status(404).send("Poster not found");

        res.set({
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*"
        });
        res.send(png);
    } catch (err) {
        console.error("AceHub poster error:", err.message);
        res.status(500).send("Poster error");
    }
});

app.use("/", getRouter(builder.getInterface()));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Xôi Chè addon running on port ${PORT}`);
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
    console.log(`AceHub LAN Host: ${ACEHUB_LAN_HOST}`);
    console.log(`Manifest: ${PUBLIC_BASE_URL}/manifest.json`);
});
