# Canvas Bulk Tools (Chrome extension)

Bulk tools for canvas.lanecc.edu:

- **Item Banks page:** share many item banks with a person or the course, review who has access, and remove access.
- **Modules page:** move, indent, publish, unpublish, or remove many module items at once; rename every module at once.
- **Gradebook:** "Add Fudge Points…" in a New Quiz column's menu, for many students at once (experimental; back up grades first).

## Install (one computer)

1. Unzip this folder somewhere it will stay (Chrome loads it from there).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
4. Open or reload a Canvas course page.

If you were using the Tampermonkey version, disable it so the tools don't appear twice.

## Update

Replace the folder's files with the new version, then click the reload icon on the extension's card in `chrome://extensions`.

## Permissions

The extension requests no Chrome permissions. It runs only on `https://canvas.lanecc.edu/courses/*` pages, inside the page itself, and acts only through Canvas and New Quizzes with your own login, so it can't do anything you couldn't do by hand. It stores nothing except a short-lived result note (in the tab's session storage) that it deletes after a reload.

## Troubleshooting

To log each step to the browser console, open the console (F12) on a Canvas page, run `localStorage.setItem('cbt-debug', '1')`, and reload. Run `localStorage.removeItem('cbt-debug')` to turn it off.

Requires Chrome 111 or later.
