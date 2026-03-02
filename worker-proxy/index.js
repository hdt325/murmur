// Proxy all requests to the Cloudflare Pages deployment
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "murmur-site-ejk.pages.dev";
    return fetch(new Request(url, request));
  },
};
