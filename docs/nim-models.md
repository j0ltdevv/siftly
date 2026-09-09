# Modèles NIM pour le fact-check Siftly

**Dernière vérification : 2026-09-08** — chaque modèle ci-dessous a été testé **en direct** avec la clé du compte (`nvidia-claude-proxy/.env`), pas de données théoriques.

> ⚠️ Le catalogue NIM change vite : `meta/llama-3.3-70b-instruct` est passé EOL le 2026-08-26 (HTTP 410), `meta/llama-3.1-405b-instruct` a été retiré (HTTP 404). Les anciennes comparaisons basées sur ces modèles étaient obsolètes dès leur écriture.

## Choix actuel

**`nvidia/nemotron-3-super-120b-a12b`** (dans `siftly/.env` → `AI_MODEL`)

- 200 OK en ~2,3 s sur un ping simple ; ~8-13 s sur les tâches réelles du pipeline (extraction + verdict)
- Sort du JSON strict sans fences ni bavardage sur les prompts du pipeline
- Modèle à raisonnement : selon les runs, un texte de raisonnement peut précéder le JSON → `app/api/factcheck/route.ts` gère ça (scan équilibré des accolades + 4 tentatives avec backoff)

## Résultats des tests du 2026-09-08

| Modèle | Statut | Notes |
|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | ✅ **retenu** | JSON propre, latence OK, raisonnement à filtrer |
| `meta/llama-3.1-405b-instruct` | ❌ 404 | retiré du catalogue |
| `meta/llama-3.3-70b-instruct` | ❌ 410 | EOL le 2026-08-26 |
| `mistralai/mistral-large-2-instruct` | ❌ 404 | non accessible pour ce compte |
| `openai/gpt-oss-20b` | ❌ hang | timeout 90 s, aucune réponse |
| `deepseek-ai/deepseek-v4-flash-0731` | ❌ hang | timeout 60 s |
| `nvidia/nemotron-3-super-120b-a12b` (retry) | ⚠️ 503 | rafales « Service temporarily overloaded » — d'où les retries dans `route.ts` |

## Autres modèles vivants sur ce compte (non testés en profondeur)

`nvidia/llama-3.1-nemotron-ultra-253b-v1` (gros, lent), `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/llama-3.1-nemotron-70b-instruct`, `mistralai/mistral-nemotron`, `nv-mistralai/mistral-nemo-12b-instruct`, `deepseek-ai/deepseek-v4-pro-0813`, `meta/llama-3.2-90b-vision-instruct` (vision, utile pour l'analyse d'images). Liste complète : `GET https://integrate.api.nvidia.com/v1/models`.

## Pour changer de modèle

1. `siftly/.env` → `AI_MODEL=<id>` (redémarrer Siftly : `systemctl --user restart siftly`)
2. Tester d'abord en direct :
   ```bash
   KEY=$(grep PROVIDER_API_KEY ../nvidia-claude-proxy/.env | cut -d= -f2)
   curl -s https://integrate.api.nvidia.com/v1/chat/completions \
     -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"model":"<id>","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":20}'
   ```
3. Vérifier que le modèle sort un JSON parsable sur les deux tâches du pipeline (extraction de claims, verdict).

## Architecture du pipeline fact-check

```
Siftly /api/factcheck (Anthropic SDK)
  → proxy local :8089  POST /v1/messages   (auth = SERVER_API_KEY)
    → NVIDIA NIM  POST /v1/chat/completions (auth = PROVIDER_API_KEY)
  Exa : POST https://api.exa.ai/search  (header x-api-key, body {query, contents:{text:true}})
```

Points d'attention :
- Le proxy n'expose **que** `/v1/messages` (format Anthropic). Un client OpenAI SDK pointé sur :8089 rendra 404.
- L'`ANTHROPIC_API_KEY` de Siftly doit égaler `SERVER_API_KEY` du proxy.
- Exa en GET ne fonctionne pas (`NOT_FOUND`) : obligatoirement POST + `x-api-key`.
