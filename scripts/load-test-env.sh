# load-test-env.sh — sourced (via `.`) by every test runner.
#
# Test processes inherit the environment of whoever launches the runner:
# developer shells, Docker Compose, or agent sandboxes. Any of those can
# define flags (ENABLE_MEMORY_REFLECTOR, JEV_*, ...) that a hermetic suite
# must not inherit, and bun's --no-env-file only stops .env file loading,
# not inherited variables. The committed .env.test is the single source of
# truth for test environments; its values are re-exported here so they
# always override inherited values (TEST_ENV_FILE can point elsewhere).
if [ -f "${TEST_ENV_FILE:-.env.test}" ]; then
  while IFS= read -r _carapa_env_line || [ -n "$_carapa_env_line" ]; do
    case "$_carapa_env_line" in
      '' | '#'*) continue ;;
      *=*) export "${_carapa_env_line%%=*}=${_carapa_env_line#*=}" ;;
    esac
  done < "${TEST_ENV_FILE:-.env.test}"
  unset _carapa_env_line
fi
