# Freebie Demo

Demomaterial für das Marketingvideo zum DEEP DESIGN Workshop: alle Bausteine eines dreiteiligen
kostenlosen Videokurses, gebaut mit dem Marit Alke Design System.
**Sämtliche Texte sind Platzhalter**, der Freebie-Titel bewusst als „Titel deines Freebies".

Startpunkt: `index.html` öffnen, dort ist alles verlinkt.

## Inhalt

| Ordner | Dateien |
|---|---|
| `landingpages/` | `01-anmeldeseite.html`, `02-bestaetigungsseite.html`, `03-dankeseite.html` |
| `kursseiten/` | `video-1.html` (mit eingebettetem Workbook), `video-2.html`, `video-3.html` |
| `mails/` | fünf Autoresponder-Mails: Bestätigung, drei Video-Mails, Abschluss mit Angebot |
| `workbook/` | `workbook.html` (Quelle) und `Workbook-Freebie-Demo.pdf` (5 Seiten) |
| `folien/` | drei HTML-Decks à drei Folien, Navigation per Pfeiltasten oder Klick |
| `social/` | Karussell in drei Designvarianten, je drei Slides à 1080 × 1350 px |
| `einbettung/` | `freebie-kasten.html` und `startseiten-highlight.html` zum Kopieren |
| `assets/` | Bilder, Schriften und die beiden Stylesheets |

## Gestaltungsentscheidungen

**Hero als wiederkehrendes Element.** Der alpine Bergsee trägt alle Landingpages und Kursseiten.
Statt eines Overlays liegt ein sehr transparenter Verlauf von unten nach oben auf dem Foto, dazu
ein Textschatten, damit das Bild möglichst vollständig sichtbar bleibt. Weiter unten taucht es ein
zweites Mal auf, stark geblurrt und anders ausgeschnitten (`.echo`).

**Titel als Logo, nicht als Webfont.** Der Freebie-Titel ist ein in Canva nachgebautes Logo und
liegt als SVG in zwei Farben vor: `assets/logo-titel-weiss.svg` für Foto- und Farbflächen,
`assets/logo-titel-tuerkis.svg` für weiße Flächen. Beide bestehen aus echten Vektorpfaden ohne
Schriftverweis, skalieren also verlustfrei von der Mailbreite bis zur A4-Titelseite. Der Titeltext
steht jeweils im `alt`-Attribut, damit Screenreader und Suchmaschinen ihn trotzdem lesen.
Die Amazone-Schriftdatei wird nicht mehr ausgeliefert.

**Folien ohne Schreibschrift.** Auf den Präsentationsfolien steht der Titel in Open Sans 700,
die kleine Marke unten rechts ist entfallen.

**Zwei Sublines im Hero.** Kurz und fett für den Nutzen (`.hero-sub-short`), darunter länger und
ruhiger für das Ergebnis (`.hero-sub-long`).

**Orangene Trennbalken** schließen jede türkise, fotografische oder Gradient-Sektion nach unten ab,
16 px unter dem Hero, 12 px sonst, 4 px unter der Navigation. Hellgrau geht ohne Balken in Weiß über.

**Grün** taucht nur als Akzent auf: Haken in Listen, Rahmen von Highlight-Boxen, einzelne Kanten.
Keine grüne Fläche.

## Vor dem echten Einsatz anzupassen

- **Mails:** Die Bildpfade in den fünf HTML-Dateien zeigen relativ auf `../assets/`. Für GetResponse
  müssen `mail-header.png` und `portrait-marit.jpg` auf öffentliche URLs umgestellt werden.
  `[[firstname]]` und `[[UNSUBSCRIBE]]` sind bereits GetResponse-Platzhalter.
- **Mail-Header:** `assets/mail-header.png` (1200 × 300 px) ist aus dem Hero-Bild plus Logo
  gerendert, weil E-Mail-Programme kein SVG zuverlässig darstellen. Bei einem echten Freebie-Titel
  neu erzeugen.
- **Einbettungs-Blöcke:** In `einbettung/` liegen zwei Dateien mit klar markiertem Kopierbereich.
  Darin ebenfalls die Bildpfade auf öffentliche URLs umstellen.
- **Karussell-Export:** Die Slides sind intern 1080 × 1350 px und nur für die Vorschau auf 0,4
  skaliert. Für den Export die `transform: scale(0.4)`-Zeile entfernen und die einzelne `.slide`
  screenshotten.
- **Formular:** Auf der Anmeldeseite markiert `.placeholder-tag` die Stelle, an der das echte
  GetResponse-Embed hinkommt.

## Stylesheets

- `assets/freebie-demo.css` — Landingpages, Kursseiten, Übersichtsseite
- `assets/folien.css` — Präsentationsfolien
- Schriften kommen komplett von Google Fonts (Open Sans für Überschriften, PT Sans für Fließtext),
  es liegt keine lokale Schriftdatei mehr im Projekt
- Karussell und Einbettungs-Blöcke bringen ihr CSS selbst mit, damit sie einzeln weiterverwendet
  werden können
