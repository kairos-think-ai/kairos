/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@kairos/core'],
  experimental: {
    serverComponentsExternalPackages: ['@anthropic-ai/sdk', 'inngest'],
    instrumentationHook: true,
  },
  webpack: (config) => {
    // Resolve .js imports to .ts files in @kairos/core (ESM uses .js extensions in source)
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.js'],
    };
    return config;
  },
};

module.exports = nextConfig;
