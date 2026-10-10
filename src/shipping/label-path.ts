// Where every label prints from, whoever sold it: katasync's saved copy
// (see label-file.ts). Free of server imports, so pages can link to it.
export const labelPath = (shipmentId: number) => `/labels/${shipmentId}`;
