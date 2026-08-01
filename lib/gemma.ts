import type { Obra, ResultadoAnalisis } from "@/types/obra";
import type { DatasetObra } from "@/types/dataset-obra";

const GEMMA_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemma-4-E4B-it";

interface GemmaResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

export class GemmaServiceError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "GemmaServiceError";
  }
}

function getConfiguration() {
  const apiKey = process.env.GEMMA_API_KEY;
  if (!apiKey) {
    throw new GemmaServiceError(
      "Gemma no está configurado. Agrega GEMMA_API_KEY a .env.local.",
      503,
    );
  }

  return {
    apiKey,
    model: process.env.GEMMA_MODEL?.trim() || DEFAULT_MODEL,
  };
}

function parseJson(text: string): ResultadoAnalisis {
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new GemmaServiceError("Gemma devolvió una respuesta que no se pudo interpretar.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new GemmaServiceError("Gemma devolvió una respuesta incompleta.");
  }

  const value = parsed as Record<string, unknown>;
  const required = ["estado", "causa", "accion_pendiente", "evidencia_textual", "resumen_ciudadano"];
  if (required.some((field) => typeof value[field] !== "string" || !value[field])) {
    throw new GemmaServiceError("Gemma devolvió campos incompletos.");
  }

  return {
    estado: value.estado as string,
    causa: value.causa as string,
    accion_pendiente: value.accion_pendiente as string,
    evidencia_textual: value.evidencia_textual as string,
    resumen_ciudadano: value.resumen_ciudadano as string,
    es_simulado: false,
  };
}

async function generateWithGemma(prompt: string): Promise<{ output: string; model: string }> {
  const { apiKey, model } = getConfiguration();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const response = await fetch(`${GEMMA_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`Gemma respondió con estado HTTP ${response.status}.`);
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new GemmaServiceError("La clave o la configuración de Gemma no es válida.", 502);
      }
      if (response.status === 429) {
        throw new GemmaServiceError("Gemma alcanzó su límite de solicitudes. Inténtalo más tarde.", 429);
      }
      throw new GemmaServiceError("Gemma no está disponible temporalmente.");
    }

    const result = (await response.json()) as GemmaResponse;
    const output = result.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!output) throw new GemmaServiceError("Gemma no devolvió contenido para analizar.");

    return { output, model };
  } catch (error) {
    if (error instanceof GemmaServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new GemmaServiceError("Gemma tardó demasiado en responder. Inténtalo nuevamente.", 504);
    }
    throw new GemmaServiceError("No se pudo conectar con Gemma.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function analizarConGemma(texto: string): Promise<ResultadoAnalisis> {
  const prompt = `Analiza el siguiente texto sobre una obra pública peruana. No inventes datos ni atribuyas responsabilidades. Si un dato no aparece, responde "No consta en el texto". Devuelve exclusivamente JSON válido, sin markdown, con estas claves de texto: estado, causa, accion_pendiente, evidencia_textual y resumen_ciudadano. La evidencia debe ser un fragmento breve del texto y el resumen debe usar lenguaje ciudadano.\n\nTEXTO:\n${texto}`;
  const { output, model } = await generateWithGemma(prompt);
  return { ...parseJson(output), modelo: model };
}

export async function responderPreguntaConGemma(
  contexto: string,
  pregunta: string,
): Promise<string> {
  const prompt = `Responde la pregunta usando exclusivamente los datos de INFOBRAS incluidos en CONTEXTO. No inventes, no completes con conocimiento externo y no atribuyas responsabilidades. Si la respuesta no está en el contexto, di claramente "Ese dato no consta en el Excel". Responde en español claro y en máximo 900 caracteres.\n\nCONTEXTO:\n${contexto}\n\nPREGUNTA:\n${pregunta}`;
  return (await generateWithGemma(prompt)).output;
}

export function obraComoTexto(obra: Obra): string {
  return [
    `Nombre: ${obra.nombre}`,
    `CUI: ${obra.codigo}`,
    `Ubicación: ${obra.distrito}, ${obra.provincia}, ${obra.region}`,
    `Estado registrado: ${obra.estado}`,
    `Avance ejecutado: ${obra.avanceEjecutado}%`,
    `Avance programado: ${obra.avanceProgramado}%`,
    `Retraso: ${obra.diasRetraso} días`,
    `Causa registrada: ${obra.causa}`,
    `Última actualización: ${obra.ultimaActualizacion}`,
  ].join("\n");
}

export function datasetObraComoTexto(obra: DatasetObra): string {
  return [
    `Fuente: ${obra.fuente}`,
    `Nombre: ${obra.nombre}`,
    `Código INFOBRAS: ${obra.codigoInfobras}`,
    `CUI: ${obra.cui}`,
    `Entidad: ${obra.entidad}`,
    `Ubicación: ${obra.distrito}, ${obra.provincia}, ${obra.departamento}`,
    `Dirección referencial: ${obra.direccion}`,
    `Estado registrado: ${obra.estado}`,
    `Presupuesto: ${obra.presupuesto ?? "No registrado"}`,
    `Avance ejecutado: ${obra.avanceEjecutado ?? "No registrado"}%`,
    `Avance programado: ${obra.avanceProgramado ?? "No registrado"}%`,
    `Días de paralización o modificación de plazo: ${obra.diasRetraso ?? "No registrados"}`,
    `Causa registrada: ${obra.causa}`,
    `Comentarios: ${obra.comentarios}`,
    `Última actualización: ${obra.ultimaActualizacion}`,
  ].join("\n");
}
