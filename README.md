# NowWeather

Live hazards console for [Standard Weather](https://standardweather.github.io/NowWeather/). Everything loads in the browser from government sources:

- Active watches, warnings and advisories (text, storm-based polygons, zone shapes) — NWS API, `api.weather.gov`
- Watches/warnings map layer in NWS colors, and the radar mosaic loop — NOAA nowCOAST
- Convective outlooks (Day 1–3, categorical and probabilistic) and storm reports — NOAA Storm Prediction Center
- Mesoscale discussions — NOAA map services
- My place: alerts at a point (NWS API `alerts/active?point=`), lightning distance, radar at the spot (MRMS) and nearby reports, with optional browser notifications while the page is open
- Storm arrival time at My place: when each warned storm reaches the spot, from the storm position, heading and speed in the warning (`eventMotionDescription`), drawn on the map as a projected track
- Storm log: conditions at My place every 5 minutes while the page is open (alerts, MRMS radar and hail, lightning, nearest NWS station wind, gust and rain), kept in the browser and downloadable as CSV or printable
- Area forecast discussions for a clicked spot — NWS API products (AFD)
- Surface observations (temperature, wind, gusts) — AWC METAR layer on NOAA map services

The page uses the shared theme at `/css/site.css` from the `standardweather.github.io` repo. Pushing to `main` deploys `site/` to GitHub Pages.
