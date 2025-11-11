// server.js (updated — improved username extraction)
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const cors = require("cors");
const querystring = require("querystring");
const { chromium } = require("playwright");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

/* -------------------------
   Utility: safe path getter
   ------------------------- */
const getPath = (obj, pathArr) => {
  try {
    return pathArr.reduce(
      (acc, k) => (acc && acc[k] != null ? acc[k] : null),
      obj
    );
  } catch {
    return null;
  }
};

/* -------------------------
   Extract JSON substring by balanced braces starting at idx
   ------------------------- */
function extractBalancedJson(str, startIdx) {
  let i = startIdx;
  // find first { from startIdx
  while (i < str.length && str[i] !== "{") i++;
  if (i >= str.length) return null;
  let depth = 0;
  let end = i;
  for (; end < str.length; end++) {
    if (str[end] === "{") depth++;
    else if (str[end] === "}") {
      depth--;
      if (depth === 0) {
        return str.slice(i, end + 1);
      }
    }
  }
  return null;
}

/* -------------------------
   Main: improved extract username
   ------------------------- */
function extractUsernameFromHtml(html) {
  if (!html || typeof html !== "string") return null;
  const $ = cheerio.load(html);

  // 1) og:title — try exact username-like tokens (but prefer later methods)
  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle) {
    const m = ogTitle.match(/@?([A-Za-z0-9._]{3,30})/);
    if (m) {
      // keep as candidate but do NOT return immediately if it's a common word.
      // however if ogTitle clearly contains "@username" it's reliable.
      if (/@[A-Za-z0-9._]{3,30}/.test(ogTitle)) return m[1];
    }
  }

  // 2) ld+json author.name (very reliable when present)
  const ld = $('script[type="application/ld+json"]')
    .map((i, el) => $(el).html() || "")
    .get()
    .join("\n");
  if (ld) {
    try {
      // ld might contain multiple JSON objects concatenated; attempt parse by splitting
      const parts = ld.split(/\}\s*\{/).map((p, idx, arr) => {
        if (arr.length === 1) return p;
        if (idx === 0) return p + "}";
        if (idx === arr.length - 1) return "{" + p;
        return "{" + p + "}";
      });
      for (const part of parts) {
        try {
          const data = JSON.parse(part);
          // common path
          const name = getPath(data, ["author", "name"]);
          if (name) return String(name).replace(/^@/, "");
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {}
  }

  // 3) Try window._sharedData (old Instagram structure)
  try {
    const sdMatch = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});/);
    if (sdMatch && sdMatch[1]) {
      try {
        const sd = JSON.parse(sdMatch[1]);
        const username =
          getPath(sd, [
            "entry_data",
            "PostPage",
            0,
            "graphql",
            "shortcode_media",
            "owner",
            "username",
          ]) ||
          getPath(sd, [
            "entry_data",
            "PostPage",
            0,
            "graphql",
            "shortcode_media",
            "owner",
            "id",
          ]) ||
          getPath(sd, [
            "entry_data",
            "ReelPage",
            0,
            "items",
            0,
            "user",
            "username",
          ]);
        if (username) return username;
      } catch (e) {
        // ignore parse error
      }
    }
  } catch (e) {}

  // 4) Try window.__additionalDataLoaded(...) pattern: window.__additionalDataLoaded("media", {...})
  try {
    const addMatches = [
      ...html.matchAll(
        /window\.__additionalDataLoaded\(['"][^'"]+['"],\s*(\{[\s\S]*?\})\)/g
      ),
    ];
    for (const mm of addMatches) {
      const jsonText = mm[1];
      try {
        const obj = JSON.parse(jsonText);
        const username =
          getPath(obj, ["graphql", "shortcode_media", "owner", "username"]) ||
          getPath(obj, ["items", 0, "user", "username"]);
        if (username) return username;
      } catch (e) {}
    }
  } catch (e) {}

  // 5) Try to find any inline JSON that contains "shortcode_media" and parse owner.username
  try {
    const idx = html.indexOf('"shortcode_media"');
    if (idx !== -1) {
      // extract surrounding JSON
      const jsonSnippet = extractBalancedJson(html, Math.max(0, idx - 50));
      if (jsonSnippet) {
        try {
          const obj = JSON.parse(jsonSnippet);
          // search recursively for owner.username
          const findOwnerUsername = (o) => {
            if (!o || typeof o !== "object") return null;
            if (
              o.username &&
              typeof o.username === "string" &&
              /^[A-Za-z0-9._]{3,30}$/.test(o.username)
            )
              return o.username;
            if (o.owner && typeof o.owner === "object" && o.owner.username)
              return o.owner.username;
            for (const k of Object.keys(o)) {
              const v = o[k];
              if (typeof v === "object") {
                const res = findOwnerUsername(v);
                if (res) return res;
              }
            }
            return null;
          };
          const username = findOwnerUsername(obj);
          if (username) return username;
        } catch (e) {
          // ignore parse
        }
      }
    }
  } catch (e) {}

  // 6) Existing inline script owner.username pattern (fallback)
  const scriptsCombined = $("script")
    .map((i, el) => $(el).html() || "")
    .get()
    .join("\n");
  const mOwner = scriptsCombined.match(
    /"owner":\s*{[^}]*"username"\s*:\s*"([^"]+)"/i
  );
  if (mOwner) return mOwner[1];

  const mUser = scriptsCombined.match(
    /"username"\s*:\s*"([A-Za-z0-9._]{3,30})"/i
  );
  if (mUser) {
    // ensure it's not matching some overlay text (best-effort): check proximity to "owner" or "shortcode_media"
    const idxUser = scriptsCombined.indexOf(mUser[0]);
    const context = scriptsCombined.slice(
      Math.max(0, idxUser - 60),
      idxUser + mUser[0].length + 60
    );
    if (/owner|shortcode_media|profile|user/i.test(context)) return mUser[1];
    // otherwise keep as a weak candidate — but prefer to continue searching
  }

  // 7) canonical profile link fallback (last resort)
  const linkMatch = html.match(
    /https?:\/\/www\.instagram\.com\/([A-Za-z0-9._]{3,30})\/?/i
  );
  if (linkMatch) return linkMatch[1];

  // 8) login wall marker
  if (html.includes("Log in") && html.includes("Sign up"))
    return "__LOGIN_WALL__";

  return null;
}

/* -------------------------
   URL helpers (same as before)
   ------------------------- */
const getFinalURLFromAxiosResponse = (resp, fallback) => {
  return (
    resp?.request?.res?.responseUrl ||
    resp?.request?._redirectable?._currentUrl ||
    resp?.request?.path ||
    fallback
  );
};

const fetchReelIdFromShareURL = async (shareUrl) => {
  const resp = await axios.get(shareUrl, {
    maxRedirects: 5,
    validateStatus: () => true,
  });
  const finalUrl = getFinalURLFromAxiosResponse(resp, shareUrl) || shareUrl;
  const match = String(finalUrl).match(/reel\/([a-zA-Z0-9_-]+)/);
  if (!match || !match[1]) throw new Error("Reel ID not found in URL");
  return match[1];
};

const getPostIdFromUrl = async (postUrl) => {
  const shareRegex =
    /^https:\/\/(?:www\.)?instagram\.com\/share\/([a-zA-Z0-9_-]+)\/?/;
  const postRegex =
    /^https:\/\/(?:www\.)?instagram\.com\/p\/([a-zA-Z0-9_-]+)\/?/;
  const reelRegex =
    /^https:\/\/(?:www\.)?instagram\.com\/reels?\/([a-zA-Z0-9_-]+)\/?/;

  if (shareRegex.test(postUrl)) return fetchReelIdFromShareURL(postUrl);
  const postMatch = postUrl.match(postRegex);
  if (postMatch?.[1]) return postMatch[1];
  const reelMatch = postUrl.match(reelRegex);
  if (reelMatch?.[1]) return reelMatch[1];
  throw new Error("Unable to extract ID from URL");
};

/* -------------------------
   GraphQL helper (best-effort)
   ------------------------- */
const encodeGraphqlRequestData = (shortcode) => {
  const requestData = {
    av: "0",
    __d: "www",
    __user: "0",
    __a: "1",
    dpr: "1",
    variables: JSON.stringify({ shortcode }),
    doc_id: "10015901848480474",
  };
  return querystring.stringify(requestData);
};

const getUsernameFromGraphQL = async (shortcode) => {
  try {
    const body = encodeGraphqlRequestData(shortcode);
    const res = await axios.post(
      "https://www.instagram.com/api/graphql",
      body,
      {
        headers: {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-IG-App-ID": "1217981644879628",
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36",
        },
        validateStatus: () => true,
        timeout: 15000,
      }
    );
    if (res.status < 200 || res.status >= 300) return null;
    const data = res.data;
    const media =
      data?.data?.xdt_shortcode_media ?? data?.data?.shortcode_media;
    const owner = media?.owner ?? media?.user ?? null;
    const username = owner?.username ?? null;
    return username || null;
  } catch (e) {
    console.warn("GraphQL fetch error:", e.message || e);
    return null;
  }
};

/* -------------------------
   fetch helpers
   ------------------------- */
async function fetchWithAxios(url) {
  const resp = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    timeout: 15000,
    validateStatus: () => true,
  });
  return resp.data;
}

async function fetchWithPlaywright(url) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1200);
    return await page.content();
  } finally {
    try {
      await page.close();
    } catch (e) {
      /* ignore */
    }
    try {
      await context.close();
    } catch (e) {
      /* ignore */
    }
    try {
      await browser.close();
    } catch (e) {
      /* ignore */
    }
  }
}

/* -------------------------
   Routes
   ------------------------- */
app.get("/", (req, res) =>
  res.render("index", { error: null, username: null, url: null })
);

app.post("/extract", async (req, res) => {
  let { url } = req.body || {};
  if (!url || typeof url !== "string" || url.trim() === "") {
    return res.render("index", {
      error: "Please provide a URL.",
      username: null,
      url: null,
    });
  }
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  try {
    // try to extract shortcode/post id (optional)
    let postId = null;
    try {
      postId = await getPostIdFromUrl(url);
    } catch (e) {
      postId = null;
    }

    // 1) axios html
    let username = null;
    try {
      const html = await fetchWithAxios(url);
      username = extractUsernameFromHtml(html);
    } catch (e) {
      console.warn("HTML fetch failed:", e.message || e);
    }

    // 2) GraphQL attempt if not found and postId present
    if ((!username || username === "__LOGIN_WALL__") && postId) {
      const gql = await getUsernameFromGraphQL(postId);
      if (gql) username = gql;
    }

    // 3) Playwright fallback
    if (!username || username === "__LOGIN_WALL__") {
      try {
        const rendered = await fetchWithPlaywright(url);
        username = extractUsernameFromHtml(rendered);
      } catch (e) {
        console.warn("Playwright failed:", e.message || e);
      }
    }

    if (username && username !== "__LOGIN_WALL__") {
      return res.render("result", { username, url });
    } else {
      return res.render("index", {
        error:
          "Username not found. Possible reasons:\n- The post is private or requires login.\n- Instagram changed its page structure.\n- Request was blocked or rate-limited.",
        username: null,
        url,
      });
    }
  } catch (err) {
    console.error("Unexpected:", err);
    return res.render("index", {
      error: "Failed: " + (err.message || "unknown"),
      username: null,
      url,
    });
  }
});

/* -------------------------
   start server
   ------------------------- */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
