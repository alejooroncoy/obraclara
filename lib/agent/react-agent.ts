/**
 * lib/agent/react-agent.ts
 *
 * Motor ReAct con tool-calling manual para el agente de obras públicas.
 * El LLM siempre responde en JSON indicando si quiere usar una herramienta
 * o si ya tiene la respuesta final. El backend ejecuta la herramienta real
 * y se la devuelve al modelo antes de que redacte la respuesta.
 *
 * Reutiliza generateWithGemma() de lib/gemma.ts (mismo cliente HTTP/API key).
 */

import { GemmaServiceError } from "../gemma";
import {
  buscar_obras,
  buscar_por_direccion,
  obtener_detalle_obra,
  obtener_historial_contratista,
} from "./tools";

// ─────────────────────────────────────────────────────────────
// Tipos internos del agente
// ─────────────────────────────────────────────────────────────

type ToolCall = {
  action: "tool_call";
  tool: string;
  args: Record<string, unknown>;
  thought?: string;
};

type FinalAnswer = {
  action: "final_answer";
  answer: string;
};

type AgentStep = ToolCall | FinalAnswer;

// ─────────────────────────────────────────────────────────────
// System prompt del agente
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres Vigía Público, un asistente especializado en obras públicas del Perú.
Tienes acceso a la base de datos INFOBRAS de la Contraloría General de la República.

Siempre respondes en JSON válido (sin markdown, sin backticks). El JSON debe tener UNO de estos formatos:

Formato A — usar herramienta:
{
  "action": "tool_call",
  "thought": "razonamiento breve de por qué usas esta herramienta",
  "tool": "<nombre_exacto_de_herramienta>",
  "args": { ... }
}

Formato B — respuesta final:
{
  "action": "final_answer",
  "answer": "texto de respuesta al usuario en español claro"
}

HERRAMIENTAS DISPONIBLES:

1. buscar_obras
   Busca obras en la BD filtrando por cualquier combinación de campos.
   Args opcionales (incluye solo los que el usuario mencionó):
   - nombre: string — fragmento del nombre de la obra
   - codigo: string — código INFOBRAS exacto
   - distrito: string — nombre del distrito
   - estado: string — "En Ejecución" | "Paralizada" | "Finalizada"
   - contratista: string — nombre o fragmento del contratista
   Retorna: { total_encontrado, truncado, obras: [...] }

2. buscar_por_direccion
   Busca obras cuya dirección se parezca a la indicada (fuzzy matching).
   Args:
   - direccion: string — REQUERIDO — dirección o referencia escrita por el usuario
   - distrito: string — OPCIONAL — para acotar la búsqueda
   Retorna: candidatos con score_similitud (0-100). Si score < 70, avisa al usuario que la coincidencia es aproximada.

3. obtener_detalle_obra
   Retorna todos los datos de una obra por su código INFOBRAS.
   Args:
   - codigo: string — REQUERIDO — código INFOBRAS exacto
   Retorna: detalle completo (contratista, monto, fechas, avance, paralizaciones, etc.)

4. obtener_historial_contratista
   Retorna todas las obras de un contratista + score de confianza calculado automáticamente.
   Args:
   - contratista: string — REQUERIDO — nombre o fragmento del contratista
   Retorna: { total_obras, finalizadas, paralizadas, score_confianza (0-100), etiqueta_confianza, obras }

REGLAS:
- Nunca calcules tú el score de confianza; ya viene calculado en el resultado de la herramienta.
- Si el usuario busca por dirección y los scores son < 70, menciona que la coincidencia es aproximada.
- Si no hay datos en la BD, indícalo claramente sin inventar información.
- No atribuyas responsabilidades ni hagas juicios. Cita los datos tal como están.
- Responde siempre en español, de forma concisa y ciudadana.
- Si necesitas múltiples herramientas, úsalas en turnos separados (primero buscar, luego detallar).`;

// ─────────────────────────────────────────────────────────────
// Cliente Gemma — llamada directa (reutiliza la misma API key/endpoint)
// ─────────────────────────────────────────────────────────────

const GEMMA_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemma-4-26b-a4b-it";

interface GemmaRawResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

async function callGemma(messages: Array<{ role: "user" | "model"; text: string }>): Promise<string> {
  const apiKey = process.env.GEMMA_API_KEY;
  if (!apiKey) {
    throw new GemmaServiceError("GEMMA_API_KEY no está configurada.", 503);
  }

  const model = process.env.GEMMA_MODEL?.trim() || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  // Construimos el diálogo: el system prompt va como primer mensaje "user",
  // seguido de los mensajes del historial. Gemma 3+ admite multi-turn.
  const contents = [
    { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
    { role: "model", parts: [{ text: '{"action":"final_answer","answer":"Entendido. Estoy listo para responder preguntas sobre obras públicas del Perú."}' }] },
    ...messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
  ];

  try {
    const response = await fetch(
      `${GEMMA_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents,
          generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      if (response.status === 429) {
        throw new GemmaServiceError("Límite de solicitudes alcanzado. Inténtalo en unos segundos.", 429);
      }
      if ([400, 401, 403].includes(response.status)) {
        throw new GemmaServiceError("Clave o configuración de Gemma no válida.", 502);
      }
      throw new GemmaServiceError("Gemma no está disponible temporalmente.", 502);
    }

    const result = (await response.json()) as GemmaRawResponse;
    const text = result.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!text) throw new GemmaServiceError("Gemma no devolvió contenido.");
    return text;
  } catch (error) {
    if (error instanceof GemmaServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GemmaServiceError("Gemma tardó demasiado. Inténtalo nuevamente.", 504);
    }
    throw new GemmaServiceError("No se pudo conectar con Gemma.");
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────
// Parser del JSON devuelto por Gemma
// ─────────────────────────────────────────────────────────────

function parseAgentStep(raw: string): AgentStep {
  // Eliminamos posibles fences de markdown que Gemma a veces agrega
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Si no parsea como JSON, lo tratamos como respuesta final en texto plano
    return { action: "final_answer", answer: raw.trim() };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new GemmaServiceError("El agente devolvió una estructura no válida.");
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.action === "tool_call" && typeof obj.tool === "string") {
    return {
      action: "tool_call",
      tool: obj.tool,
      args: (obj.args as Record<string, unknown>) ?? {},
      thought: typeof obj.thought === "string" ? obj.thought : undefined,
    };
  }

  if (obj.action === "final_answer" && typeof obj.answer === "string") {
    return { action: "final_answer", answer: obj.answer };
  }

  // Fallback: si hay un campo "answer" directamente
  if (typeof obj.answer === "string") {
    return { action: "final_answer", answer: obj.answer };
  }

  throw new GemmaServiceError("El agente devolvió un JSON con formato desconocido.");
}

// ─────────────────────────────────────────────────────────────
// Dispatcher de herramientas
// ─────────────────────────────────────────────────────────────

async function executeTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  try {
    let result: unknown;

    switch (toolName) {
      case "buscar_obras":
        result = await buscar_obras(args as Parameters<typeof buscar_obras>[0]);
        break;
      case "buscar_por_direccion":
        result = await buscar_por_direccion(
          args as Parameters<typeof buscar_por_direccion>[0],
        );
        break;
      case "obtener_detalle_obra":
        result = await obtener_detalle_obra(
          args as Parameters<typeof obtener_detalle_obra>[0],
        );
        if (result === null) {
          result = { error: `No se encontró ninguna obra con código "${(args as { codigo: string }).codigo}".` };
        }
        break;
      case "obtener_historial_contratista":
        result = await obtener_historial_contratista(
          args as Parameters<typeof obtener_historial_contratista>[0],
        );
        break;
      default:
        result = { error: `La herramienta "${toolName}" no existe. Herramientas disponibles: buscar_obras, buscar_por_direccion, obtener_detalle_obra, obtener_historial_contratista.` };
    }

    return JSON.stringify(result, null, 0);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error desconocido al ejecutar la herramienta.";
    return JSON.stringify({ error: msg });
  }
}

// ─────────────────────────────────────────────────────────────
// Loop ReAct principal
// ─────────────────────────────────────────────────────────────

const MAX_TURNS = 4;

/**
 * Ejecuta el agente ReAct para responder una pregunta del usuario.
 * @param userMessage — Texto libre del usuario
 * @returns Respuesta final en texto plano para enviar por Telegram
 */
export async function runReactAgent(userMessage: string): Promise<string> {
  // Historial de mensajes para el contexto multi-turn
  const messages: Array<{ role: "user" | "model"; text: string }> = [
    { role: "user", text: userMessage },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const rawResponse = await callGemma(messages);

    let step: AgentStep;
    try {
      step = parseAgentStep(rawResponse);
    } catch {
      // Si no podemos parsear, devolvemos lo que dijo Gemma como texto
      return rawResponse.slice(0, 4000);
    }

    if (step.action === "final_answer") {
      return step.answer;
    }

    // Es un tool_call — ejecutar la herramienta y agregar resultado al historial
    const toolResult = await executeTool(step.tool, step.args);

    // Apendemos el paso del modelo y el resultado de la herramienta como mensajes
    messages.push({ role: "model", text: rawResponse });
    messages.push({
      role: "user",
      text: `RESULTADO DE HERRAMIENTA (${step.tool}):\n${toolResult}\n\nAhora redacta la respuesta final para el usuario en formato "final_answer".`,
    });
  }

  // Si agotamos los turnos sin respuesta final
  return "No pude completar la consulta en el tiempo permitido. Intenta reformular tu pregunta o sé más específico.";
}
