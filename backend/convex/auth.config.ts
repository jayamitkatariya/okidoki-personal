// Convex Auth signs its own tokens; this tells the deployment to trust them.
// CONVEX_SITE_URL is set by Convex (self-hosted: from CONVEX_SITE_ORIGIN in docker-compose.yml).
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
