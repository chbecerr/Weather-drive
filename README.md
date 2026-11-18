# Weather Drive

Enter a destination and see the weather you'll drive through on the way there.

- Start from your current location (browser geolocation) or type an origin.
- Departure defaults to now; pick a later time and the app uses the forecast for when you'll actually pass each point (with a warning that accuracy drops further out).
- Samples the route roughly every 50 km, shows a map plus a timeline of temperature, wind, rain/snow chance, and flags hazards (storms, ice, heavy rain/snow, fog, high gusts).
- Driving only. °F/mph or °C/km/h.

Static site, no build step, no API keys: Leaflet + OpenStreetMap tiles, Nominatim (geocoding), OSRM (routing), Open-Meteo (forecast).

## Run locally
Open `index.html` in a browser, or `python3 -m http.server`.

## Deploy to GitHub Pages
Repo **Settings → Pages → Deploy from a branch**, choose the branch and `/ (root)`.

Note: Nominatim and the public OSRM server are free community services with fair-use limits; fine for personal use.
