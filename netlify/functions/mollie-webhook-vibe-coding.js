const https = require("https");
const tls   = require("tls");

const MOLLIE_API_KEY      = process.env.MOLLIE_API_KEY_VIBE_CODING;
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY;

// GetResponse-Liste "Vibe-Coding Experimentiertage" (ID: 70NcY, per API angelegt 09.09.2026)
const GR_CAMPAIGN_ID      = "70NcY";
const GR_TAG_NAME         = "vibe_coding_teilnehmerin";

// Bestell-Benachrichtigung per E-Mail: verschickt bei jeder erfolgreichen Zahlung
// zusätzlich eine eigene Mail mit allen Metadaten über Posteo (SMTP, kein npm-Paket
// nötig), damit Marit die Rechnungsadresse nicht mühsam aus der Mollie-Benachrichtigungsmail
// rauskopieren muss (übernommen 1:1 aus dem DEEP-DESIGN-Webhook).
const POSTEO_EMAIL    = process.env.POSTEO_EMAIL;
const POSTEO_PASSWORD = process.env.POSTEO_PASSWORD;
const NOTIFY_TO       = "info@marit-alke.de";

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

  // GetResponse-Update und Benachrichtigungsmail sind voneinander unabhängig – parallel
  // statt nacheinander ausführen, damit die Gesamtlaufzeit nicht die Summe, sondern nur
  // das Maximum beider Vorgänge ist (wichtig wegen Netlifys Zeitlimit für Functions).
  await Promise.all([updateGetResponse(email, firstName), sendNotificationMail(payment)]);

  return { statusCode: 200, body: "OK" };
};

async function updateGetResponse(email, firstName) {
  try {
    const tagId = await getOrCreateTag(GR_TAG_NAME);
    await upsertContact(email, firstName, GR_CAMPAIGN_ID, tagId);
    console.log(`GetResponse OK: ${email}`);
  } catch (err) {
    console.error("GetResponse Fehler:", err.message);
  }
}

async function sendNotificationMail(payment) {
  if (!(POSTEO_EMAIL && POSTEO_PASSWORD)) {
    console.log("Benachrichtigungsmail übersprungen: POSTEO_EMAIL/POSTEO_PASSWORD nicht gesetzt");
    return;
  }
  try {
    const { subject, text } = buildNotificationEmail(payment);
    await sendMail({
      host: "posteo.de",  // nicht "smtp.posteo.de", diesen Namen gibt es nicht (Ursache der fehlenden Info-Mails, 11.09.2026)
      port: 465,
      user: POSTEO_EMAIL,
      pass: POSTEO_PASSWORD,
      from: POSTEO_EMAIL,
      to: NOTIFY_TO,
      subject,
      text
    });
    console.log("Bestell-Benachrichtigung OK");
  } catch (err) {
    // Nie den Webhook scheitern lassen, wenn nur die Benachrichtigungsmail fehlschlägt –
    // die eigentliche Bestellung (GetResponse) ist bereits durch, das ist nur ein
    // zusätzlicher Komfort-Hinweis für Marit.
    console.error("Benachrichtigungsmail Fehler:", err.message);
  }
}

// ── Bestell-Benachrichtigung per E-Mail ─────────────────────────────────────────

function buildNotificationEmail(payment) {
  const m = payment.metadata || {};
  const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || "(unbekannt)";
  const amount = payment.amount ? `${payment.amount.value} ${payment.amount.currency}` : "(unbekannt)";
  const dashboardUrl = payment._links && payment._links.dashboard ? payment._links.dashboard.href : "";

  const vatLine = m.vatId
    ? `${m.vatId}${m.vatValidated === "true" && m.vatCheckNote ? " (" + m.vatCheckNote + ")" : ""}`
    : "(keine)";

  const lines = [
    `Neue Bestellung: Vibe-Coding Experimentiertage`,
    ``,
    `Name: ${name}`,
    `E-Mail: ${m.email || "(unbekannt)"}`,
    `Firma: ${m.company || "(keine)"}`,
    `Adresse: ${m.street || ""}, ${m.zip || ""} ${m.city || ""}, ${m.country || ""}`,
    `USt-IdNr.: ${vatLine}`,
    `Reverse Charge: ${m.reverseCharge === "true" ? "ja" : "nein"}`,
    `Zahlbetrag: ${amount}`,
    `Mollie Payment-ID: ${payment.id || "(unbekannt)"}`,
    dashboardUrl ? `Mollie Dashboard: ${dashboardUrl}` : null,
    ``,
    `Rechnung bitte wie gewohnt manuell in Lexoffice erstellen.`
  ].filter(line => line !== null);

  return {
    subject: `Neue Bestellung: ${name}`,
    text: lines.join("\n")
  };
}

// ── Minimaler SMTP-Client (Posteo, kein npm-Paket) ──────────────────────────────
// 1:1 übernommen aus mollie-webhook-deep-design.js (AUTH PLAIN, Dot-Stuffing,
// eigenes Timeout, s. dortige Kommentare zur Herleitung/zum Bugfix vom 07.09.2026).

function sendMail({ host, port, user, pass, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {});
    let buffer = "";
    let step = 0;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      reject(err);
    }
    function done() {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch (e) {}
      resolve();
    }
    function send(line) { socket.write(line + "\r\n"); }
    const b64 = s => Buffer.from(s, "utf8").toString("base64");

    // Kürzer als Mollies eigenes Webhook-Timeout (15s) und deutlich unter dem Zeitlimit
    // für synchrone Netlify Functions, damit im Fehlerfall garantiert noch rechtzeitig
    // 200 OK an Mollie zurückgegeben werden kann, statt dass die ganze Function abbricht.
    socket.setTimeout(8000, () => fail(new Error("SMTP Timeout")));
    socket.on("error", fail);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.endsWith("\r\n")) return;
      const lines = buffer.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return;
      const code = last.slice(0, 3);
      buffer = "";

      try {
        switch (step) {
          case 0:
            if (code !== "220") throw new Error("Unerwartete Begrüßung: " + last);
            send(`EHLO lp.marit-alke.de`);
            step = 1;
            break;
          case 1:
            if (code !== "250") throw new Error("EHLO fehlgeschlagen: " + last);
            send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
            step = 2;
            break;
          case 2:
            if (code !== "235") throw new Error("Login fehlgeschlagen: " + last);
            send(`MAIL FROM:<${from}>`);
            step = 3;
            break;
          case 3:
            if (code !== "250") throw new Error("MAIL FROM fehlgeschlagen: " + last);
            send(`RCPT TO:<${to}>`);
            step = 4;
            break;
          case 4:
            if (code !== "250") throw new Error("RCPT TO fehlgeschlagen: " + last);
            send("DATA");
            step = 5;
            break;
          case 5:
            if (code !== "354") throw new Error("DATA fehlgeschlagen: " + last);
            {
              const subjEnc = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
              const headers = [
                `From: ${from}`,
                `To: ${to}`,
                `Subject: ${subjEnc}`,
                `Date: ${new Date().toUTCString()}`,
                `Content-Type: text/plain; charset=UTF-8`,
                `MIME-Version: 1.0`,
                ""
              ].join("\r\n");
              const escapedBody = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n").replace(/^\./gm, "..");
              socket.write(headers + "\r\n" + escapedBody + "\r\n.\r\n");
            }
            step = 6;
            break;
          case 6:
            if (code !== "250") throw new Error("Senden fehlgeschlagen: " + last);
            send("QUIT");
            step = 7;
            break;
          case 7:
            done();
            break;
        }
      } catch (err) {
        fail(err);
      }
    });
  });
}

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
    req.setTimeout(8000, () => req.destroy(new Error(`Mollie-Anfrage Timeout: ${path}`)));
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
    req.setTimeout(8000, () => req.destroy(new Error(`GetResponse-Anfrage Timeout: ${path}`)));
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
    req.setTimeout(8000, () => req.destroy(new Error(`GetResponse-Anfrage Timeout: ${path}`)));
    if (payload) req.write(payload);
    req.end();
  });
}
