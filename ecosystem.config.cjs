module.exports = {
  apps: [{
    name: 'carapa-board',
    script: 'src/index.ts',
    interpreter: 'bun',
    interpreter_args: 'run',
    cwd: __dirname,
    env_file: '.env',
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: false,
    // Restart policy
    autorestart: true,
    max_restarts: 10,
    restart_delay: 2000,
    // Logging
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    merge_logs: true,
    time: true,
  }]
};
