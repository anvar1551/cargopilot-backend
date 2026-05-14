type AddressTextInput = {
  addressLine1?: string | null;
  addressLine2?: string | null;
  street?: string | null;
  building?: string | null;
  floor?: string | null;
  apartment?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
  landmark?: string | null;
};

/** Converts a structured address object into one compact display line. */
export function buildAddressText(addr: AddressTextInput | null | undefined): string {
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

