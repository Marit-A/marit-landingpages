const https = require("https");
const tls   = require("tls");
const { produkte } = require("./baukasten-produkte.json");

// Baukasten-Webhook: einer für alle Produkte aus baukasten-produkte.json.
// Nach einer bezahlten Zahlung:
// 1. Kurszugang im SimpleCourses-Plugin freischalten (nur Produkte mit "kurszugang")
// 2. parallel dazu: Kontakt in die GetResponse-Liste des Produkts eintragen
//    (die Liste verschickt als Autoresponder die Bestätigungsmail)
// 3. Bestell-Info an Marit, sobald Schritt 1 fertig ist, mit dessen Ergebnis
// SMTP-Client und GetResponse-Aufrufe 1:1 aus mollie-webhook-vibe-coding.js.
const MOLLIE_API_KEY      = process.env.MOLLIE_API_KEY_BAUKASTEN;
const GETRESPONSE_API_KEY = process.env.GETRESPONSE_API_KEY;
const POSTEO_EMAIL        = process.env.POSTEO_EMAIL;
const POSTEO_PASSWORD     = process.env.POSTEO_PASSWORD;
const NOTIFY_TO           = "info@marit-alke.de";

// Kursplattformen mit dem Kauf-Eingang des SimpleCourses-Plugins (class-purchase-api.php).
// Das Kennwort steht dort in der wp-config.php als SC_PURCHASE_SECRET.
const PLATTFORMEN = {
  kurse: { url: "https://kurse.marit-alke.de", secret: process.env.SC_PURCHASE_SECRET_KURSE },
  hub:   { url: "https://hub.marit-alke.de",   secret: process.env.SC_PURCHASE_SECRET_HUB }
};

// Rechnungsstellung: weiterhin manuell in Lexoffice (s. MOLLIE-SETUP.md).

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

  const m = payment.metadata || {};
  const produkt = Object.values(produkte).find(p => p.kennung === m.product);

  if (!produkt) {
    console.error(`Payment ${paymentId}: Produkt "${m.product}" steht nicht in baukasten-produkte.json`);
    return { statusCode: 200, body: "OK" };
  }
  if (!m.email) {
    console.error("Keine E-Mail in Payment-Metadata");
    return { statusCode: 200, body: "OK" };
  }

  // GetResponse läuft parallel zum Kurszugang. Die Info-Mail wartet auf den Kurszugang,
  // damit Marit darin sieht, ob die Freischaltung geklappt hat.
  const [, zugang] = await Promise.all([
    updateGetResponse(produkt, m.email, m.firstName || "", rabattFuer(produkt, m.discountCode)),
    (async () => {
      const ergebnis = await freischalten(produkt, payment, rabattFuer(produkt, m.discountCode));
      await sendNotificationMail(produkt, payment, ergebnis);
      return ergebnis;
    })()
  ]);

  // Vorübergehender Fehler beim Kurszugang (WordPress nicht erreichbar oder 5xx):
  // 500 zurückgeben, dann wiederholt Mollie den Webhook später. Der Kauf-Eingang
  // erkennt die Zahlung wieder, doppelt freigeschaltet wird nichts.
  if (zugang.wiederholen) {
    return { statusCode: 500, body: "Kurszugang fehlgeschlagen, bitte wiederholen" };
  }
  return { statusCode: 200, body: "OK" };
};

// ── Kurszugang ────────────────────────────────────────────────────────────────

// Rabattcode aus der Zahlung -> Eintrag in baukasten-produkte.json (oder null)
function rabattFuer(produkt, code) {
  const codes = produkt.rabattcodes || {};
  return code && Object.prototype.hasOwnProperty.call(codes, code) ? codes[code] : null;
}

async function freischalten(produkt, payment, rabatt) {
  // Rabattcode mit kein_kurszugang: Zugang läuft über die Registrierungs-/Login-Seite
  if (rabatt && rabatt.kein_kurszugang) {
    return { ok: true, text: "kein automatischer Zugang (Rabattcode, Zugang über Registrierungs-/Login-Seite)" };
  }
  const kz = produkt.kurszugang;
  if (!kz) return { ok: true, wiederholen: false, text: null };

  const handarbeit = `Bitte Kurs ${kz.kurs_id} von Hand freischalten.`;
  const plattform = PLATTFORMEN[kz.plattform];
  if (!plattform || !plattform.secret) {
    return { ok: false, wiederholen: false, text: `FEHLER: Für die Plattform "${kz.plattform}" fehlt das Kennwort in Netlify. ${handarbeit}` };
  }

  const m = payment.metadata || {};
  try {
    const antwort = await jsonPost(
      `${plattform.url}/wp-json/simple-courses/v1/purchase`,
      { "X-SC-Secret": plattform.secret },
      { email: m.email, first_name: m.firstName || "", last_name: m.lastName || "", course_id: kz.kurs_id, extra_course_ids: kz.weitere_kurs_ids || [], payment_id: payment.id },
      6000
    );

    if (antwort.status === 200) {
      const b = antwort.body;
      const konto = b.result === "duplicate"
        ? "war schon freigeschaltet"
        : (b.user_created ? "neues Konto angelegt, WordPress hat die Passwort-Mail verschickt" : "bestehendes Konto");
      const kurse = (b.courses || []).length ? `, Kurs-IDs ${b.courses.join(", ")}` : "";
      console.log(`Kurszugang OK: ${m.email} (${konto})`);
      return { ok: true, wiederholen: false, text: `freigeschaltet auf ${kz.plattform} (${konto}${kurse})` };
    }

    // 4xx heißt: falsches Kennwort, Kurs nicht veröffentlicht o.ä. Wiederholen hilft nicht.
    const wiederholen = antwort.status >= 500;
    const grund = antwort.body.message || antwort.body.code || "unbekannter Fehler";
    console.error(`Kurszugang Fehler ${antwort.status}: ${grund}`);
    return {
      ok: false,
      wiederholen,
      text: `FEHLER ${antwort.status} (${grund}). ${wiederholen ? "Mollie versucht es später automatisch noch einmal." : handarbeit}`
    };
  } catch (err) {
    console.error("Kurszugang nicht erreichbar:", err.message);
    return { ok: false, wiederholen: true, text: `FEHLER: ${err.message}. Mollie versucht es später automatisch noch einmal.` };
  }
}

// ── GetResponse ───────────────────────────────────────────────────────────────

async function updateGetResponse(produkt, email, firstName, rabatt) {
  const gr = (rabatt && rabatt.getresponse) || produkt.getresponse || {};
  if (!gr.liste_id) {
    console.log(`GetResponse übersprungen: keine Liste für ${produkt.kennung}`);
    return;
  }
  try {
    const tagId = gr.tag ? await getOrCreateTag(gr.tag) : null;
    await upsertContact(email, firstName, gr.liste_id, tagId);
    console.log(`GetResponse OK: ${email}`);
  } catch (err) {
    console.error("GetResponse Fehler:", err.message);
  }
}

async function getOrCreateTag(name) {
  const tags = await grRequest("GET", `/tags?query[name]=${encodeURIComponent(name)}`);
  if (Array.isArray(tags) && tags.length > 0) return tags[0].tagId;
  const newTag = await grRequest("POST", "/tags", { name });
  return newTag.tagId;
}

async function upsertContact(email, firstName, campaignId, tagId) {
  const body = { email, name: firstName, campaign: { campaignId }, dayOfCycle: "0", ...(tagId ? { tags: [{ tagId }] } : {}) };
  const status = await grRequestWithStatus("POST", "/contacts", body);
  if (status === 409) {
    // Schon in dieser Liste: nur den Tag ergänzen
    const contact = await getContactByEmail(email, campaignId);
    if (contact && tagId) {
      await grRequest("POST", `/contacts/${contact.contactId}/tags`, { tags: [{ tagId }] });
    }
  } else if (status >= 400) {
    throw new Error(`Kontakt anlegen fehlgeschlagen (HTTP ${status})`);
  }
}

async function getContactByEmail(email, campaignId) {
  const list = await grRequest("GET", `/contacts?query[email]=${encodeURIComponent(email)}&query[campaignId]=${campaignId}&additionalFlags=exactMatch`);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

// ── Bestell-Benachrichtigung per E-Mail ─────────────────────────────────────────

async function sendNotificationMail(produkt, payment, zugang) {
  if (!(POSTEO_EMAIL && POSTEO_PASSWORD)) {
    console.log("Benachrichtigungsmail übersprungen: POSTEO_EMAIL/POSTEO_PASSWORD nicht gesetzt");
    return;
  }
  try {
    const { subject, text } = buildNotificationEmail(produkt, payment, zugang);
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
    // Nie den Webhook scheitern lassen, wenn nur die Benachrichtigungsmail fehlschlägt
    console.error("Benachrichtigungsmail Fehler:", err.message);
  }
}

function buildNotificationEmail(produkt, payment, zugang) {
  const m = payment.metadata || {};
  const name = [m.firstName, m.lastName].filter(Boolean).join(" ") || "(unbekannt)";
  const amount = payment.amount ? `${payment.amount.value} ${payment.amount.currency}` : "(unbekannt)";
  const dashboardUrl = payment._links && payment._links.dashboard ? payment._links.dashboard.href : "";

  const vatLine = m.vatId
    ? `${m.vatId}${m.vatValidated === "true" && m.vatCheckNote ? " (" + m.vatCheckNote + ")" : ""}`
    : "(keine)";

  const lines = [
    `Neue Bestellung: ${produkt.name}`,
    ``,
    `Name: ${name}`,
    `E-Mail: ${m.email || "(unbekannt)"}`,
    `Firma: ${m.company || "(keine)"}`,
    `Adresse: ${m.street || ""}, ${m.zip || ""} ${m.city || ""}, ${m.country || ""}`,
    `USt-IdNr.: ${vatLine}`,
    `Reverse Charge: ${m.reverseCharge === "true" ? "ja" : "nein"}`,
    `Zahlbetrag: ${amount}`,
    m.discountCode ? `Rabattcode: ${m.discountCode}` : null,
    zugang.text ? `Kurszugang: ${zugang.text}` : null,
    produkt.digitaler_inhalt ? `Zustimmung sofortiger Beginn (Widerrufsrecht erlischt): ${m.widerrufVerzicht === "true" ? "ja" : "nein"}` : null,
    `Mollie Payment-ID: ${payment.id || "(unbekannt)"}`,
    dashboardUrl ? `Mollie Dashboard: ${dashboardUrl}` : null,
    ``,
    `Rechnung bitte wie gewohnt manuell in Lexoffice erstellen.`
  ].filter(line => line !== null);

  return {
    subject: `${zugang.ok ? "" : "⚠️ Kurszugang prüfen! "}Neue Bestellung: ${name}`,
    text: lines.join("\n")
  };
}

// ── Minimaler SMTP-Client (Posteo, kein npm-Paket) ──────────────────────────────
// 1:1 übernommen aus mollie-webhook-vibe-coding.js (AUTH PLAIN, Dot-Stuffing,
// eigenes Timeout, s. mollie-webhook-deep-design.js zur Herleitung vom 07.09.2026).

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

// POST mit JSON an eine beliebige Adresse (Kauf-Eingang in WordPress).
// Liefert Status und gelesene Antwort, wirft nur bei Netzwerkfehler oder Zeitüberschreitung.
function jsonPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ziel = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: ziel.hostname,
      path: ziel.pathname + ziel.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "lp.marit-alke.de Baukasten",
        ...headers
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { message: data.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed || {} });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Zeitüberschreitung bei ${ziel.hostname}`)));
    req.write(payload);
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
