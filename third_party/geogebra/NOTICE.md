# GeoGebra

GeoGebra Math Apps Bundle **5.4.934.0**, unmodified upstream web runtime.

- Source: https://github.com/geogebra/geogebra
- Bundle: https://download.geogebra.org/installers/5.4/geogebra-math-apps-bundle-5-4-934-0.zip
- SHA-256: `bb55da6967d949949204c20b598bd5c6dc2116100b1908efd9461ffa7f6ce1d0`
- Copyright: GeoGebra GmbH and contributors. https://www.geogebra.org
- Official license: https://www.geogebra.org/license
- Embedding and self-hosting: https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_Embedding/

The official license distinguishes the EUPL 1.2 source code from the bundled
materials and services. The distributed Math Apps Bundle includes materials
subject to GeoGebra's non-commercial terms; commercial use requires the relevant
GeoGebra agreement. This integration does not grant that agreement or relicense
the upstream runtime. Preserve upstream attribution and included font licenses.

The TOASTER bridge, UI and database integration are project code. The runtime is
loaded on demand in a sandbox on a separate static origin. It cannot read the parent
application's DOM, storage or authentication cookies. No GeoGebra cloud account,
resource library or paid service is bundled. The upstream source link remains
available in the classroom tool and runtime manifest.
