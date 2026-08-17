export function publicEndpointUrl(baseUrl: string | URL, suffix: string): URL {
  const url = new URL(baseUrl instanceof URL ? baseUrl.href : baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const childPath = suffix.replace(/^\/+/, "");
  url.pathname = `${basePath}/${childPath}` || "/";
  url.search = "";
  url.hash = "";
  return url;
}

export function oauthAuthorizationServerMetadataPath(issuerUrl: string | URL): string {
  const issuer = new URL(issuerUrl instanceof URL ? issuerUrl.href : issuerUrl);
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/+$/, "");
  return `/.well-known/oauth-authorization-server${issuerPath}`;
}
