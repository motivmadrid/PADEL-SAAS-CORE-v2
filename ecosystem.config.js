module.exports = {
  apps: [
    {
      name: 'padel-backend-cluster',
      script: 'dist/main.js',
      instances: 'max', // PM2 escalará automáticamente al máximo número de CPUs disponibles (Cluster Mode)
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
