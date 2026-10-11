const bundleUrl = process.argv[2];
if (!bundleUrl) throw new Error("bundle URL argument is required");
const bundle = await import(bundleUrl);
if (typeof bundle.run !== "function") throw new Error("bundle did not export run");
