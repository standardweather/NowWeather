# NowWeather

Live hazards console for [Standard Weather](https://standardweather.github.io/NowWeather/). Everything loads in the browser from government sources:

- Active watches, warnings and advisories (text, storm-based polygons, zone shapes) — NWS API, `api.weather.gov`
- Watches/warnings map layer in NWS colors, and the radar mosaic loop — NOAA nowCOAST
- Convective outlooks (Day 1–3, categorical and probabilistic) and storm reports — NOAA Storm Prediction Center
- Mesoscale discussions — NOAA map services

The page uses the shared theme at `/css/site.css` from the `standardweather.github.io` repo. Pushing to `main` deploys `site/` to GitHub Pages.
