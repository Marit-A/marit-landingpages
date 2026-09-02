const https = require("https");

const MOLLIE_API_KEY      = process.env.MOLLIE_API_KEY_DEEP_DESIGN;
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY;
const GR_CAMPAIGN_ID      = "7mzut"; // DEEP DESIGN Workshop
const GR_TAG_NAME         = "deep_design_teilnehmerin";

// Rechnungsstellung: aktuell bewusst NICHT automatisiert (Mollie Sales Invoice API
// ist Beta und instabil, s. MOLLIE-SETUP.md). Marit erstellt Rechnungen manuell in
// Lexoffice anhand der Mollie-Benachrichtigungsmail bzw. des Mollie-Dashboards.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const params    = new URLSearchParams(event.body);
  const paymentId = params.get("id");

  if (!paymentId) {
    return { statusCode: 400, body: "Kein Payment-ID" };
  }

  let payment;
  try {
    payment = await mollieRequest("GET", `/payments/${paymentId}`);
  } catch (err) {
    console.error("Mollie fetch Fehler:", err.message);
    // Bei dauerhaften Fehlern (z.B. 404, falscher Modus) 200 zurückgeben,
    // sonst wiederholt Mollie den Webhook-Aufruf stundenlang.
    if (err.message.includes("404")) return { statusCode: 200, body: "OK" };
    return { statusCode: 500, body: "Fehler" };
  }

  if (payment.status !== "paid") {
    console.log(`Payment ${paymentId} status: ${payment.status} – ignoriert`);
    return { statusCode: 200, body: "OK" };
  }

  const { firstName = "", email = "" } = payment.metadata || {};

  if (!email) {
    console.error("Keine E-Mail in Payment-Metadata");
    return { statusCode: 200, body: "OK" };
  }

  try {
    const tagId = await getOrCreateTag(GR_TAG_NAME);
    await upsertContact(email, firstName, GR_CAMPAIGN_ID, tagId);
    console.log(`GetResponse OK: ${email}`);
  } catch (err) {
    console.error("GetResponse Fehler:", err.message);
  }

  return { statusCode: 200, body: "OK" };
};

// ── GetResponse ───────────────────────────────────────────────────────────────

async function getOrCreateTag(name) {
  const tags = await grRequest("GET", `/tags?query[name]=${encodeURIComponent(name)}`);
  if (Array.isArray(tags) && tags.length > 0) return tags[0].tagId;
  const newTag = await grRequest("POST", "/tags", { name });
  return newTag.tagId;
}

async function upsertContact(email, firstName, campaignId, tagId) {
  const body = { email, name: firstName, campaign: { campaignId }, tags: [{ tagId }], dayOfCycle: "0" };
  const status = await grRequestWithStatus("POST", "/contacts", body);
  if (status === 409) {
    const contact = await getContactByEmail(email);
    if (contact) {
      await grRequest("POST", `/contacts/${contact.contactId}/tags`, { tags: [{ tagId }] });
    }
  }
}

async function getContactByEmail(email) {
  const list = await grRequest("GET", `/contacts?query[email]=${encodeURIComponent(email)}&additionalFlags=exactMatch`);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

// ── HTTP Helfer ───────────────────────────────────────────────────────────────

function mollieRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.mollie.com",
      path: `/v2${path}`,
      method,
      headers: {
        "Authorization": `Bearer ${MOLLIE_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) { reject(new Error(`Mollie ${res.statusCode}: ${data}`)); return; }
        resolve(JSON.parse(data));
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function grRequestWithStatus(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.getresponse.com",
      path: `/v3${path}`,
      method,
      headers: {
        "X-Auth-Token": `api-key ${GETRESPONSE_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function grRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.getresponse.com",
      path: `/v3${path}`,
      method,
      headers: {
        "X-Auth-Token": `api-key ${GETRESPONSE_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) { reject(new Error(`GetResponse ${res.statusCode}: ${data}`)); return; }
        try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
