# SAD Mobile — ASYCUDA SAD generator for your phone

Generate **ASYCUDA SAD import files on a phone**, in the browser. Open a filled SAD model or template, check the figures, type any missing duty rates, and download the **official ASYCUDA SAD model filled in** — ready to import.

- 📱 **Mobile web app** — no install needed; add it to the home screen to use it like an app.
- 🔒 **Private** — files are read and created on the phone. Nothing is uploaded to any server.
- ✈️ **Works offline** after the first visit.
- 📄 **Same output as the desktop app** — the SAD model keeps its dropdowns, field-hint comments, hidden currency columns and formatting.

**Open it:** `https://quantscript007.github.io/asycuda-sad-mobile/` (after GitHub Pages is switched on — see below).

<table>
<tr>
<td width="25%"><img src="docs/review.png" alt="Review screen"></td>
<td width="25%"><img src="docs/dark.png" alt="Insights in dark mode"></td>
<td width="25%"><img src="docs/result.png" alt="SAD ready"></td>
<td width="25%"><img src="docs/form.png" alt="Manual entry form"></td>
</tr>
</table>
<sub>Screenshots use made-up demo data.</sub>

## What it does

| Tab | |
|---|---|
| **📁 File** | Open an `.xls` / `.xlsx` from the phone (Files, Drive, WhatsApp downloads…): the SAD model, the simple template, or a SAD made earlier. |
| **Review** | Shipment details, tariff switch (**General / SAFTA / CMFTA**), insights — goods, duty & effective rate, CIF, landed cost, mass, cost build-up, duty by HS chapter, value by origin, rate bands, top duty items, invoice / package checks — and every item with an editable duty rate and a 🔎 link to the Maldives Customs tariff search. |
| **⚡ Generate** | Download or **share** (WhatsApp, email, Drive…) the filled **SAD model** and the **duty worksheet**. |
| **✍️ Form** | Enter a shipment by hand. The form is saved on the phone as you type. |
| **🗂 History** | The last 30 generated SADs, kept on the phone — download, share or delete. |
| **❓ Help** | Blank SAD model, model with sample rows, simple template. |

ASYCUDA field limits from the model are applied with a warning: description 49 characters, brand / model / size 24, packing codes 5.

### Duty rates

A browser can't query the customs website directly, so rates come from your file (e.g. a `duty_rate` column in the simple template, or a duty worksheet from the desktop app) or are typed on the review screen. Tap 🔎 on an item to look it up on the Maldives Customs tariff.

## Switching on GitHub Pages (one time)

1. Open the repository → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. The *Test & deploy to GitHub Pages* workflow publishes the site on every push to `main` (or run it from the **Actions** tab).

Then open `https://<your-user>.github.io/asycuda-sad-mobile/` on the phone. In Chrome use **⋮ → Add to Home screen**; in Safari **Share → Add to Home Screen**.

## Run it locally

Any static web server works (the app needs `http://`, not `file://`):

```bash
python3 -m http.server 8080
# open http://localhost:8080 — or http://<your-PC-IP>:8080 from a phone on the same Wi-Fi
```

## How it works

Plain HTML/CSS/JavaScript — no build step.

```
index.html            the app (4 tabs + result sheet)
css/app.css           mobile-first styles, light & dark
js/app.js             UI
js/sad-core.js        read workbooks, duty, analytics, fill the SAD model, duty worksheet
js/xls-template.js    edits .xls cells in place so dropdowns & comments survive
js/store.js           history (IndexedDB) and form draft (localStorage)
templates/SAD_MODEL.xls   the ASYCUDA SAD model
vendor/xlsx.full.min.js   SheetJS 0.18.5 (Apache-2.0) for reading Excel files
sw.js, manifest.webmanifest   offline support / install
```

`sad-core.js` and `xls-template.js` are JavaScript ports of the desktop app's Python modules and produce the same results (checked against it in development).

To use an updated SAD model, replace `templates/SAD_MODEL.xls` and bump `CACHE` in `sw.js`.

## Tests

```bash
npm ci
npm test
```

The tests fill the SAD model, check that dropdown, comment, drawing, merge and column records are unchanged, read the result back, and verify duty, analytics and the duty worksheet.

## Notes

- SheetJS 0.18.5 is the last version on npm. It is only used to read files you choose yourself on your own device.
- Always check HS codes and duty before lodging a declaration.
