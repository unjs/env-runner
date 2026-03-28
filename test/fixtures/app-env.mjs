export default {
  fetch(request) {
    const headers = {};
    for (const [key, value] of request.headers) {
      headers[key] = value;
    }
    return Response.json({
      headers,
      env: {
        VERCEL: process.env.VERCEL,
        VERCEL_ENV: process.env.VERCEL_ENV,
        VERCEL_REGION: process.env.VERCEL_REGION,
        NOW_REGION: process.env.NOW_REGION,
      },
    });
  },
};
