module.exports = {
  apps : [{
    name   : "wa-bridge",
    script : "./dist/index.js",
    env_production: {
      NODE_ENV: "production"
    },
    env_file: ".env"
  }]
};
