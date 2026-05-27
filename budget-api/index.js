const https = require("https");
const crypto = require("crypto");

const COSMOS_URI = process.env.COSMOS_URI;
const COSMOS_KEY = process.env.COSMOS_KEY;
const DATABASE_ID = "my-apps-db";
const CONTAINER_ID = "budget";
const USER_ID = "default-user";

function getAuthHeader(method, resourceType, resourceId, date) {
  const key = Buffer.from(COSMOS_KEY, "base64");
  const text = [
    method.toLowerCase(),
    resourceType.toLowerCase(),
    resourceId,
    date.toLowerCase(),
    "",
    ""
  ].join("\n");
  const hmac = crypto.createHmac("sha256", key).update(text, "utf8").digest("base64");
  return encodeURIComponent("type=master&ver=1.0&sig=" + hmac);
}

function cosmosRequest(method, path, resourceType, resourceId, body) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const auth = getAuthHeader(method, resourceType, resourceId, date);
    const host = COSMOS_URI.replace("https://", "").replace(/\/$/, "").replace(/:443$/, "");
    const bodyStr = body ? JSON.stringify(body) : "";

    const headers = {
      "Authorization": auth,
      "x-ms-date": date,
      "x-ms-version": "2018-12-31",
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    if (resourceType === "docs") {
      headers["x-ms-documentdb-partitionkey"] = JSON.stringify([USER_ID]);
    }

    if (bodyStr) {
      headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8").toString();
    }

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
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("Request timed out"));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function ensureDatabase() {
  const res = await cosmosRequest("POST", "/dbs", "dbs", "", { id: DATABASE_ID });
  // 201 = created, 409 = already exists — both are fine
  if (res.status !== 201 && res.status !== 409) {
    throw new Error("Failed to ensure database: " + res.status + " " + JSON.stringify(res.body));
  }
}

async function ensureContainer() {
  const res = await cosmosRequest(
    "POST",
    "/dbs/" + DATABASE_ID + "/colls",
    "colls",
    "dbs/" + DATABASE_ID,
    { id: CONTAINER_ID, partitionKey: { paths: ["/userId"], kind: "Hash" } }
  );
  if (res.status !== 201 && res.status !== 409) {
    throw new Error("Failed to ensure container: " + res.status + " " + JSON.stringify(res.body));
  }
}

async function getDocument() {
  const resourceId = "dbs/" + DATABASE_ID + "/colls/" + CONTAINER_ID + "/docs/" + USER_ID;
  const path = "/" + resourceId;
  const res = await cosmosRequest("GET", path, "docs", resourceId, null);
  if (res.status === 200) return res.body;
  if (res.status === 404) return null;
  throw new Error("Failed to get document: " + res.status + " " + JSON.stringify(res.body));
}

async function upsertDocument(data) {
  const doc = { ...data, id: USER_ID, userId: USER_ID };

  // Try to create first
  const createRes = await cosmosRequest(
    "POST",
    "/dbs/" + DATABASE_ID + "/colls/" + CONTAINER_ID + "/docs",
    "docs",
    "dbs/" + DATABASE_ID + "/colls/" + CONTAINER_ID,
    doc
  );

  if (createRes.status === 201) return createRes;

  // If already exists (409), replace it
  if (createRes.status === 409) {
    const resourceId = "dbs/" + DATABASE_ID + "/colls/" + CONTAINER_ID + "/docs/" + USER_ID;
    const replaceRes = await cosmosRequest(
      "PUT",
      "/" + resourceId,
      "docs",
      resourceId,
      doc
    );
    if (replaceRes.status === 200) return replaceRes;
    throw new Error("Failed to replace document: " + replaceRes.status + " " + JSON.stringify(replaceRes.body));
  }

  throw new Error("Failed to create document: " + createRes.status + " " + JSON.stringify(createRes.body));
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
