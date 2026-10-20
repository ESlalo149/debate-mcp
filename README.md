# Debate MCP

Servidor MCP compartido y autopiloto local para debatir un tema entre OpenCode y Antigravity, guardar la transcripción y producir un plan.

## Requisitos

- Runtime: Node.js 24 + TypeScript.
- Requiere `opencode` y `agy` autenticados en el usuario actual.
- El servidor escucha solo en `127.0.0.1:4599`.

## Instalación

```powershell
git clone https://github.com/ESlalo149/debate-mcp.git
cd debate-mcp
npm ci
```

## Ejecución

```powershell
cd debate-mcp
.\scripts\start-debate.ps1 -Topic "Tema a debatir" -Rounds 6 -Detached
```

`-Detached` deja el debate corriendo aunque cierres esta conversación. El progreso se escribe en `data\autopilot.log`; errores del proceso van a `data\autopilot.stderr.log` y, si una sala falla, a `data\rooms\<id>\error.log`. Para esperar en primer plano, omite `-Detached`.

Por defecto ambos asientos usan Antigravity CLI con `gemini-3.8-flash-low`. Para escoger otros modelos de Antigravity:

```powershell
.\scripts\start-debate.ps1 -Topic "Tema" -Rounds 2 -Engine agy -Detached
```

Se pueden cambiar con `-ProposerModel` y `-CriticModel`. Para usar OpenCode como proponente y Antigravity como crítico, indica `-Engine both`.

Para conservar acentos y signos en temas largos, también acepta un archivo UTF-8:

```powershell
Set-Content -Encoding utf8 .\tema.txt "¿Qué enfoque conviene?"
.\scripts\start-debate.ps1 -TopicFile .\tema.txt -Rounds 6 -Detached
```

Para dejar el servidor MCP listo sin iniciar debate:

```powershell
.\scripts\start-debate.ps1 -ServerOnly
```

También se puede ejecutar directamente:

```powershell
npm install
npm run build
npm run debate -- --topic "Tema a debatir" --rounds 6
npm test
npm run format:check
```

Antigravity usa por defecto `gemini-3.8-flash-low` para ambos asientos; OpenCode usa `openai/gpt-6-luna-fast`. Se pueden cambiar con `-OpenCodeModel`, `-AgyModel`, `-ProposerModel`, `-CriticModel`, `OPENCODE_MODEL`, `AGY_MODEL` y `AGY_EFFORT`.

OpenCode headless recibe `OPENCODE_CONFIG_CONTENT` únicamente en el proceso hijo, con los servidores MCP configurados en este entorno desactivados y todas sus tools bloqueadas. La configuración global permanece intacta y el autopiloto es el único que publica turnos. El agente sigue pudiendo responder texto en modo plan.

Timeouts configurables por CLI y fase, en milisegundos: `DEBATE_TIMEOUT_OPENCODE_TURN_MS`, `DEBATE_TIMEOUT_OPENCODE_SIGNOFF_MS`, `DEBATE_TIMEOUT_OPENCODE_PLAN_MS` y sus equivalentes `DEBATE_TIMEOUT_AGY_*_MS`. También aceptan un fallback por proveedor (`DEBATE_TIMEOUT_OPENCODE_MS`, `DEBATE_TIMEOUT_AGY_MS`) o global (`DEBATE_TIMEOUT_MS`). Defaults: turno 4 min, firma 3 min, síntesis 5 min. `DEBATE_MAX_RETRIES` (0–5, default 2) y `DEBATE_RETRY_BASE_MS`/`DEBATE_RETRY_MAX_MS` controlan reintentos transitorios. Cuota agotada y 429 ambiguo fallan rápido y dejan plan parcial.

## Datos producidos

Cada sala crea `data/rooms/<id>/` con:

- `<id>.json`: turno, estado, mensajes y acuerdo.
- `<id>\transcript.md`: transcripción legible.
- `<id>\plan.md`: plan final, decisiones, pasos, riesgos y dissent.
- `<id>\result.json`: resultado de la ejecución.

La carpeta `data/` está excluida de Git. `DEBATE_DATA_DIR` permite cambiar la ubicación.

## MCP manual

El endpoint Streamable HTTP es `http://127.0.0.1:4599/mcp`; estado en `/health`. Ambos clientes se configuran como clientes remotos al mismo endpoint. El MCP ofrece `room_create`, `room_list`, `room_join`, `room_status`, `room_post`, `room_read`, `room_wait`, `room_save_plan`, `room_close` y `room_export_transcript`.

Para el modo manual, inicia a cada agente con su asiento (`opencode` o `antigravity`) y pídele que consulte `room_status`, publique cuando le toque y repita `room_wait` si queda idle. Al aceptar una propuesta, `room_post` debe incluir `acceptedRevisionId` con la revisión exacta mostrada por `room_read`; puede incluir `idempotency_key` para que repetir una publicación sea seguro. MCP no puede reactivar una conversación que ya terminó.

## Consenso

Se considera consenso solo si OpenCode y Antigravity aceptan la misma revisión SHA-256, no dejan puntos abiertos y Antigravity firma la revisión persistida. Una propuesta editada genera una revisión nueva. Si no se consigue acuerdo antes del máximo de rondas, se guarda `no_consensus` y las objeciones quedan en `Dissent`.

## Diagnóstico rápido

```powershell
Invoke-RestMethod http://127.0.0.1:4599/health
opencode mcp list
agy mcp list
```

Después de cambiar la configuración MCP, reinicia OpenCode y actualiza/reinicia Antigravity IDE.

## Licencia

Este proyecto se distribuye bajo la licencia MIT. Consulta [LICENSE](LICENSE).
