"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAddressText = buildAddressText;
/** Converts a structured address object into one compact display line. */
function buildAddressText(addr) {
    const parts = [
        addr?.addressLine1,
        addr?.addressLine2,
        addr?.street,
        addr?.building ? `Bldg ${addr.building}` : null,
        addr?.floor ? `Fl. ${addr.floor}` : null,
        addr?.apartment ? `Apt ${addr.apartment}` : null,
        addr?.neighborhood,
        addr?.city,
        addr?.postalCode,
        addr?.country,
        addr?.landmark ? `Landmark: ${addr.landmark}` : null,
    ].filter(Boolean);
    return parts.join(", ");
}
