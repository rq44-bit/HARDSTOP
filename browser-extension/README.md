# HardStop Browser Extension

This package is the HardStop browser extension for Chrome, Edge, Brave, and other supported Chromium browsers. It works with the HardStop desktop application to block known gambling websites and show the HardStop blocked page.

## Install in Chrome

1. Install and open the HardStop desktop application first.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Select this `browser-extension` folder.
6. Open the HardStop extension setup page and select **Enable Protection**.

HardStop only reports browser protection as connected after the running extension completes a verified native-desktop handshake and a real blocking test.

## Included

- Manifest V3 browser extension source
- Packaged gambling-domain rules and blocklist metadata
- HardStop setup, popup, options, and blocked pages
- Extension logo assets

## Not Included

This folder does not include the private Windows application source, backend services, API keys, credentials, certificates, signing keys, user data, or browsing history.

## Privacy

The extension uses local browser rules for blocking. It does not sell browsing or behavioral data. A verified local blocklist remains available when the update service is unreachable.

## Security

Install only from this repository or a future official browser-store listing. Report security issues privately to the HardStop team; do not include personal browsing details or credentials in a report.

Copyright (c) 2026 HardStop. All rights reserved.
