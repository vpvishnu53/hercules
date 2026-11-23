# Hercules

Hercules is a mobile-first workout log. Log a set in one or two taps, see your PRs ("milestones"), and browse past sessions on a calendar. Plain HTML, CSS and JavaScript, with no framework, build step or dependencies.

## Run it locally

Service workers and the home-screen manifest need `http://`, so serve the folder rather than opening the file:

```
python -m http.server 8765
```

Then open http://localhost:8765. The tests are at http://localhost:8765/tests.html.

## Files

| File | What it does |
|---|---|
| `index.html` | App shell and bottom tab bar |
| `styles.css` | Theme tokens (Panel / IBM Plex / Green / 4px, light and dark) and all styles |
| `app.js` | Screens: Log, Calendar, PRs, Settings |
| `storage.js` | **The only file that touches saved data.** Promise-based `Store` API over localStorage. To add a sync backend, give `Store.init()` a backend with the same `load()` / `save()` shape. |
| `prs.js` | Pure PR rules and chart data |
| `samples.js` | Deterministic nine weeks of sample training (Settings → tap the version 5 times → Load sample data) |
| `sw.js` | Offline support |
| `tests.html` | 42 tests for storage, PR rules, chart data and sample data. They run against an in-memory store and never touch your data. |

## PR rules

- Weight PR: a heavier typed weight than every earlier set of that exercise. Blank (bodyweight) counts as 0, so +10 beats bodyweight and −20 (less assistance) beats −30.
- Rep PR: more reps than any earlier set at exactly the same weight. A set that is a weight PR is not also a rep PR.
- The first two sessions of an exercise are the baseline; PRs count from the 3rd.
- Earlier sets in the same session count. Ties don't count. Drop sets never count.
- Weights are stored in kg at full precision and compared with a 0.01 kg tolerance.
- PRs are saved. Editing or deleting a set recalculates that exercise's PRs.

## Data

Everything is saved in the browser on the device (localStorage). Nothing is sent anywhere. Use Settings → Export data now and then to keep a backup file.

## Offline and updates

After the first visit, the app works without signal. App files are served from the offline cache and refreshed in the background, so a new version appears the **second** time you open the app after an update. Bump `VERSION` in `sw.js` (and `APP_VERSION` in `app.js`) for each release.
