# Volumio Remote (desklet)

A "now playing" card for the desktop that shows what a Volumio instance on your
network is playing and lets you change its volume.

## Features

- Album art, song title, artist and, for web radio, the station name
- Long titles scroll sideways instead of being cut off
- Volume: mute, down/up, clickable volume bar, percentage; scroll over the card to change the volume
- If Volumio has no real artwork (typical for web radio), the cover is looked up
  from the artist and song title, with strict matching so a wrong cover is rejected.
  If the artist is empty or "no name", "Artist - Song" titles are split and used instead.
  The source is a setting: MusicBrainz / Cover Art Archive first with iTunes as backup
  (default), MusicBrainz / Cover Art Archive only (open data), iTunes only, or off.
- Adjustable shape and colours: layout (art left or on top), width, height, card
  corner radius, art shape (square / rounded / circle), background colour and
  opacity, text colour

## Setup

1. Add the desklet to your desktop.
2. Open its settings and enter the IP address or host name of your Volumio
   (for example `192.168.1.50` or `volumio.local`).

## Requirements

- A Volumio instance reachable from this computer (uses Volumio's REST API on port 80)
- `curl` (installed by default on Linux Mint)

Artwork lookups use the open MusicBrainz database and Cover Art Archive
(`musicbrainz.org`, `coverartarchive.org`) and, optionally, the public iTunes Search API
(`itunes.apple.com`). They are only made when Volumio does not provide a cover.
