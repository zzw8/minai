module.exports = {
  apps: [
    {
      name: "minai",
      script: "server.py",
      interpreter: "python3",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "300M",
      env: {
        PORT: 3000
      }
    }
  ]
};
