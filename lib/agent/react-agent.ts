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

const SYSTEM_PROMPT = `Eres Vigía Público, asistente especializado en obras públicas del Perú (base de datos INFOBRAS, Contraloría General de la República).

REGLA ABSOLUTA: Tu respuesta debe ser ÚNICAMENTE un objeto JSON válido. NADA antes. NADA después. Sin markdown, sin backticks, sin razonamiento, sin explicaciones previas.

El JSON debe tener exactamente UNO de estos dos formatos:

Formato A — invocar herramienta:
{"action":"tool_call","tool":"<nombre>","args":{...}}

Formato B — respuesta final al usuario:
{"action":"final_answer","answer":"<texto en español>"}

HERRAMIENTAS:

1. buscar_obras — filtra obras por cualquier combinación de:
   nombre (texto), codigo (código INFOBRAS), distrito, estado ("En Ejecución"|"Paralizada"|"Finalizada"), contratista
   → Devuelve: {total_encontrado, truncado, obras:[...]}

2. buscar_por_direccion — fuzzy matching sobre el campo dirección:
   args: {"direccion":"...","distrito":"..."(opcional)}
   → Devuelve candidatos con score_similitud 0-100. Si score<70 avisa al usuario.

3. obtener_detalle_obra — datos completos de una obra:
   args: {"codigo":"<código INFOBRAS exacto>"}
   → Devuelve: contratista, montos, fechas, avance físico, paralizaciones, etc.

4. obtener_historial_contratista — todas las obras + score de confianza (ya calculado, no lo calcules tú):
   args: {"contratista":"<nombre o fragmento>"}
   → Devuelve: {total_obras, finalizadas, paralizadas, score_confianza, etiqueta_confianza, obras:[...]}

REGLAS DE NEGOCIO:
- Nunca calcules el score de confianza tú mismo; ya viene en el resultado.
- "LIMA" es una región/provincia, no un distrito. Busca sin filtrar por distrito si el usuario dice solo "Lima".
- Si no hay datos, indícalo sin inventar información.
- Responde siempre en español claro y ciudadano.
- Si necesitas múltiples herramientas, úsalas en turnos: primero busca, luego detalla.

Recuerda: SOLO JSON. Nada más.`;


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

/**
 * Extrae el primer objeto JSON válido con campo "action" de un texto que
 * puede contener razonamiento libre antes/después del JSON.
 * Gemma a veces "piensa en voz alta" antes de emitir el JSON.
 */
function extractJsonFromText(raw: string): string | null {
  // 1. Buscar fence de código ```json ... ```
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // 2. Buscar todos los bloques {...} y devolver el primero que tenga "action"
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = raw.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>;
          // Solo aceptar si tiene el campo "action"
          if (typeof parsed.action === "string") return candidate;
        } catch {
          // No era JSON válido, seguir buscando
        }
        start = -1;
      }
    }
  }
  return null;
}

function parseAgentStep(raw: string): AgentStep {
  const jsonStr = extractJsonFromText(raw);

  // Si no encontramos JSON estructurado, tratar la respuesta completa como respuesta final
  if (!jsonStr) {
    // Limpiar el texto de backticks y prefijos de razonamiento comunes
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    return { action: "final_answer", answer: cleaned.slice(0, 3000) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { action: "final_answer", answer: raw.trim().slice(0, 3000) };
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
 * Elimina el bloque de razonamiento ("thinking") que Gemma 4 externaliza.
 *
 * Patrón observado: el modelo escribe bullet points con asterisco (`*   *texto*`)
 * para su cadena de pensamiento, y luego escribe la respuesta limpia como texto
 * normal o lista numerada. Por lo tanto, buscamos el último bloque continuo de
 * texto que NO contenga líneas de bullet asterisco — ese es la respuesta real.
 */
function stripThinking(raw: string): string {
  const lines = raw.split("\n");

  // Detectar si hay thinking (líneas que empiezan con `*` seguido de espacio o más `*`)
  const isThinkingLine = (line: string) => /^\s{0,4}\*(?:\s|\*)/.test(line);
  const hasThinkin = lines.some(isThinkingLine);
  if (!hasThinkin) return raw; // Sin thinking — devolver intacto

  // Encontrar el índice de la última línea de thinking
  let lastThinkingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isThinkingLine(lines[i])) {
      lastThinkingIdx = i;
      break;
    }
  }

  // Tomar todo lo que viene después de la última línea de thinking
  const after = lines
    .slice(lastThinkingIdx + 1)
    .join("\n")
    .trim();

  // Solo usar si el resultado es sustancioso (más de 40 caracteres)
  if (after.length > 40) return after;

  // Fallback: buscar la sección que empieza con "El " / "Los " / "La " (artículo español)
  // en la segunda mitad del texto — suele ser el inicio de la respuesta final
  const spanishStart = raw.lastIndexOf("\n\nEl ");
  if (spanishStart !== -1 && raw.length - spanishStart < raw.length * 0.6) {
    return raw.slice(spanishStart).trim();
  }

  return raw; // Si todo falla, devolver original
}

/**
 * Llamada final separada: Gemma redacta la respuesta en texto libre (sin JSON).
 * Al no exigirle formato JSON, evitamos que meta razonamientos en el campo "answer".
 */
async function finalizeAnswer(
  userMessage: string,
  toolResults: Array<{ tool: string; result: string }>,
): Promise<string> {
  const apiKey = process.env.GEMMA_API_KEY;
  if (!apiKey) throw new GemmaServiceError("GEMMA_API_KEY no está configurada.", 503);
  const model = process.env.GEMMA_MODEL?.trim() || DEFAULT_MODEL;

  const datosRecopilados = toolResults
    .map((r, i) => `--- Resultado ${i + 1} (${r.tool}) ---\n${r.result}`)
    .join("\n\n");

  const prompt =
    `Eres Vigía Público, asistente de obras públicas del Perú (fuente: INFOBRAS, Contraloría).\n` +
    `Pregunta del usuario: "${userMessage}"\n\n` +
    `DATOS OBTENIDOS DE LA BASE DE DATOS:\n${datosRecopilados}\n\n` +
    `INSTRUCCION: Escribe DIRECTAMENTE la respuesta en español para el usuario. ` +
    `Empieza inmediatamente con el contenido (ej: "El contratista...", "Se encontraron...", etc.). ` +
    `NO escribas razonamientos, notas internas, viñetas de análisis ni listas de verificación. ` +
    `Solo el texto que el ciudadano verá. Máx. 6 resultados si hay muchos.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(
      `${GEMMA_ENDPOINT}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
          // Nota: thinkingConfig (budget:0) es solo para Gemini, NO para Gemma — no incluir.
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Gemma finalizeAnswer HTTP ${response.status}:`, body.slice(0, 200));
      throw new GemmaServiceError(
        `Gemma no pudo redactar la respuesta (HTTP ${response.status}).`,
        502,
      );
    }

    const result = (await response.json()) as GemmaRawResponse;
    const rawText = result.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();

    if (!rawText) return "No pude redactar una respuesta con los datos disponibles.";

    // Eliminar el bloque de thinking si el modelo lo externalizó de todas formas
    return stripThinking(rawText);
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

/**
 * Ejecuta el agente ReAct para responder una pregunta del usuario.
 * Fase 1: loop de tool-calling en JSON estricto (máx MAX_TURNS iteraciones).
 * Fase 2: llamada separada en texto libre para redactar la respuesta final.
 * @param userMessage — Texto libre del usuario
 * @returns Respuesta final en texto plano para enviar por Telegram
 */
export async function runReactAgent(userMessage: string): Promise<string> {
  const messages: Array<{ role: "user" | "model"; text: string }> = [
    { role: "user", text: userMessage },
  ];

  // Acumulamos todos los resultados de herramientas para la fase final
  const toolResults: Array<{ tool: string; result: string }> = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const rawResponse = await callGemma(messages);

    let step: AgentStep;
    try {
      step = parseAgentStep(rawResponse);
    } catch {
      // Si no se puede parsear el JSON de planificación, intentar como respuesta final
      if (toolResults.length > 0) break; // tenemos datos, ir a la fase final
      return rawResponse.slice(0, 3500);
    }

    if (step.action === "final_answer") {
      // Gemma dice que tiene la respuesta — si ya tenemos datos de herramientas,
      // usamos la fase final limpia; si no, devolvemos lo que dijo.
      if (toolResults.length > 0) break;
      return step.answer;
    }

    // Es un tool_call — ejecutar y acumular resultado
    const toolResult = await executeTool(step.tool, step.args);
    toolResults.push({ tool: step.tool, result: toolResult });

    // Agregar al historial para el próximo turno
    messages.push({ role: "model", text: rawResponse });
    messages.push({
      role: "user",
      text:
        `RESULTADO DE HERRAMIENTA (${step.tool}):\n${toolResult}\n\n` +
        `Si necesitas otra herramienta, indícala en formato JSON tool_call. ` +
        `Si ya tienes suficientes datos, responde: {"action":"final_answer","answer":"listo"}`,
    });
  }

  // ── Fase 2: redacción final en texto libre ──
  if (toolResults.length === 0) {
    return "No encontré datos relevantes para responder tu consulta. Intenta ser más específico.";
  }

  return finalizeAnswer(userMessage, toolResults);
}
