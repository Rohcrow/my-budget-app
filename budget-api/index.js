const https = require("https");
const crypto = require("crypto");

const COSMOS_URI = process.env.COSMOS_URI;
const COSMOS_KEY = process.env.COSMOS_KEY;
const DATABASE_ID = "my-apps-db";
const CONTAINER_ID = "budget";
const USER_ID = "default-user";

function getAuthHeader(method, resourceType, resourceId, date) {
  const key = Buffer.from(COSMOS_KEY, "base64");
  const text = `${method.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceId}\n${date.toLowerCase()}\n\n`;
  const hmac = crypto.createHmac("sha256", key).update(text).digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${hmac}`);
}

function cosmosRequest(method, path, resourceType, resourceId, body) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const auth = getAuthHeader(method, resourceType, resourceId, date);
    const host = COSMOS_URI.replace("https://", "").replace("/", "").replace(/:443$/, "");
    const bodyStr = body ? JSON.stringify(body) : "";
    const headers = {
      "Authorization": auth,
      "x-ms-date": date,
      "x-ms-version": "2018-12-31",
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-ms-documentdb-partitionkey": `["${USER_ID}"]`,
    };
    if (body) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: method,
      headers: headers,
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

async function ensureDatabase() {
  await cosmosRequest("POST", "/dbs", "dbs", "", { id: DATABASE_ID });
}

async function ensureContainer() {
  await cosmosRequest("POST", `/dbs/${DATABASE_ID}/colls`, "colls", `dbs/${DATABASE_ID}`, {
    id: CONTAINER_ID,
    partitionKey: { paths: ["/userId"], kind: "Hash" }
  });
}

async function getDocument() {
  const path = `/dbs/${DATABASE_ID}/colls/${CONTAINER_ID}/docs/${USER_ID}`;
  const res = await cosmosRequest("GET", path, "docs", `dbs/${DATABASE_ID}/colls/${CONTAINER_ID}/docs/${USER_ID}`, null);
  if (res.status === 200) return res.body;
  return null;
}

async function upsertDocument(data) {
  const doc = { ...data, id: USER_ID, userId: USER_ID };
  const path = `/dbs/${DATABASE_ID}/colls/${CONTAINER_ID}/docs`;
  const res = await cosmosRequest("POST", path, "docs", `dbs/${DATABASE_ID}/colls/${CONTAINER_ID}`, doc);
  if (res.status === 409) {
    const putPath = `/dbs/${DATABASE_ID}/colls/${CONTAINER_ID}/docs/${USER_ID}`;
    return await cosmosRequest("PUT", putPath, "docs", `dbs/${DATABASE_ID}/colls/${CONTAINER_ID}/docs/${USER_ID}`, doc);
  }
  return res;
}

module.exports = async function (context, req) {
  context.res = {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  };

  if (req.method === "OPTIONS") {
    context.res.status = 200;
    context.res.body = "";
    return;
  }

  try {
    await ensureDatabase();
    await ensureContainer();

    if (req.method === "GET") {
      const doc = await getDocument();
      context.res.status = 200;
      context.res.body = JSON.stringify(doc || { userId: USER_ID, appData: null });

    } else if (req.method === "POST") {
      await upsertDocument(req.body);
      context.res.status = 200;
      context.res.body = JSON.stringify({ success: true });

    } else {
      context.res.status = 405;
      context.res.body = JSON.stringify({ error: "Method not allowed" });
    }
  } catch (err) {
    context.res.status = 500;
    context.res.body = JSON.stringify({ error: err.message });
  }
};
