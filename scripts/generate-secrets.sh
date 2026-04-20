#!/usr/bin/env bash
# =============================================================================
# generate-secrets.sh
# Genera secretos criptográficamente seguros para el archivo .env.
#
# Uso:
#   bash scripts/generate-secrets.sh
#
# Requisitos:
#   - openssl (preinstalado en macOS y la mayoría de sistemas Linux)
#
# Los valores se imprimen por pantalla listos para copiar al .env real.
# Cada ejecución produce valores distintos — no reutilices secretos entre
# entornos (development, staging, production).
# =============================================================================

set -euo pipefail

# -- Colores para la salida ---------------------------------------------------
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

# -- Verificar que openssl está disponible ------------------------------------
if ! command -v openssl &>/dev/null; then
  echo "Error: openssl no está instalado o no está en el PATH." >&2
  exit 1
fi

# -- Generar secretos (256 bits = 32 bytes = 64 caracteres hex) ---------------
JWT_ACCESS_SECRET="$(openssl rand -hex 32)"
JWT_REFRESH_SECRET="$(openssl rand -hex 32)"

# POSTGRES_PASSWORD: 16 bytes (32 hex) es suficiente para una contraseña de BD.
# Evitamos caracteres especiales que romperían la URL de conexión sin encodear.
POSTGRES_PASSWORD="$(openssl rand -hex 16)"

# STRIPE_WEBHOOK_SECRET real siempre viene de Stripe:
#   • Desarrollo: `stripe listen --print-secret`  (Stripe CLI)
#   • Producción:  Dashboard → Developers → Webhooks → tu endpoint
# Este valor generado con openssl sirve para tests y entornos sin Stripe CLI.
STRIPE_WEBHOOK_SECRET="whsec_$(openssl rand -hex 32)"

# -- Salida -------------------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}✔ Secretos generados correctamente${RESET}"
echo -e "${YELLOW}Copia las líneas siguientes en tu archivo .env:${RESET}"
echo ""
echo -e "${CYAN}─────────────────────────────────────────────────────────────────${RESET}"
echo ""
echo "POSTGRES_PASSWORD=\"${POSTGRES_PASSWORD}\""
echo ""
echo "JWT_ACCESS_SECRET=\"${JWT_ACCESS_SECRET}\""
echo "JWT_REFRESH_SECRET=\"${JWT_REFRESH_SECRET}\""
echo ""
echo "STRIPE_WEBHOOK_SECRET=\"${STRIPE_WEBHOOK_SECRET}\""
echo ""
echo -e "${CYAN}─────────────────────────────────────────────────────────────────${RESET}"
echo ""
echo -e "${YELLOW}⚠  NOTAS IMPORTANTES:${RESET}"
echo "  • JWT_ACCESS_SECRET y JWT_REFRESH_SECRET deben ser DISTINTOS entre sí."
echo "  • POSTGRES_PASSWORD usa solo caracteres hex (0-9, a-f) para evitar"
echo "    problemas de encoding en DATABASE_URL."
echo "  • STRIPE_WEBHOOK_SECRET en producción debe obtenerse del Dashboard de Stripe,"
echo "    no de este script. El valor generado aquí solo es válido para tests locales."
echo "  • Recuerda actualizar DATABASE_URL en .env con la nueva POSTGRES_PASSWORD."
echo "  • Guarda estos valores en un gestor de secretos (1Password, Vault, AWS Secrets"
echo "    Manager...) antes de cerrar esta terminal."
echo "  • Nunca comitees el archivo .env al repositorio."
echo ""
