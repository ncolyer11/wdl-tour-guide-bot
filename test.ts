console.log("---- DEBUG INFO ----");

console.log("Loaded token length:", personalAccessToken.length);
console.log("Using Authorization header:", `Bearer ${personalAccessToken.slice(0, 10)}...`);
console.log("Requesting URL:", url);

const response = await fetch(url, {
  headers: {
    Authorization: `Bearer ${personalAccessToken}`, // ← FIXED HERE
    'User-Agent': 'World Download Bot'
  }
});

console.log("GitHub API responded with status:", response.status);
console.log("Response headers:", response.headers);
console.log("---- END DEBUG ----");
