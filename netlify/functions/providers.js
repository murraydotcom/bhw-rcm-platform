/* Provider / billing-entity registry — shared by eligibility + discovery.
 * These are the NPIs/TINs used on the 270 and discovery requests. */
const BILLING_ENTITIES = {
  bhw:       { organizationName: "BALTIMORE HEALTHCARE AND WELLNESS LLC", npi: "1306511597", taxId: "872107587" },
  amaris:    { organizationName: "AMARIS P MURRAY",                        npi: "1841844222", taxId: "853802386" },
  addiction: { organizationName: "BHW ADDICTION MANAGEMENT",              npi: "1114626363", taxId: "932227140" },
};

function provider(entity) {
  return BILLING_ENTITIES[entity] || BILLING_ENTITIES.bhw;
}

module.exports = { BILLING_ENTITIES, provider };
