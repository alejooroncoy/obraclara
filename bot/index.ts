import { loadEnvConfig } from "@next/env";
import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { closePool } from "../lib/db";
import { loadDatasetObras } from "../lib/dataset-obras";
import { formatCurrency } from "../lib/formatters";
import {
  analizarConGemma,
  datasetObraComoTexto,
  responderPreguntaConGemma,
} from "../lib/gemma";
import { runReactAgent } from "../lib/agent/react-agent";
import { findNearbyObras } from "../lib/nearby-obras";

loadEnvConfig(process.cwd());

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("No se encontró TELEGRAM_BOT_TOKEN. Agrégalo a .env.local.");
  }

  console.log("Vigía Público está leyendo data/dataset.xlsx…");
  const obras = await loadDatasetObras();
  if (obras.length === 0) throw new Error("dataset.xlsx no contiene obras utilizables.");
  console.log(`Dataset de INFOBRAS listo: ${obras.length} registros.`);

  const bot = new Bot(token);
  const selectedByChat = new Map<number, number>();
  const locationKeyboard = new Keyboard()
    .requestLocation("📍 Compartir mi ubicación")
    .resized()
    .oneTime();

  bot.command("start", async (ctx) => {
    selectedByChat.delete(ctx.chat.id);
    await ctx.reply(
      "¡Hola! Soy Vigía Público, el bot de ObraClara.\n\n" +
        "📍 Comparte tu ubicación para ver las 3 obras más cercanas de INFOBRAS.\n" +
        "💬 O escribe directamente tu consulta sobre cualquier obra pública del Perú (uso el agente inteligente con datos reales de Postgres).\n\n" +
        "Comandos:\n" +
        "/consulta — Activa el modo agente libre\n" +
        "/start — Reinicia y vuelve al menú principal\n\n" +
        "⚠️ Las distancias por ubicación son simuladas (el dataset no incluye coordenadas reales).",
      { reply_markup: locationKeyboard },
    );
  });

  // Comando /consulta y alias /agente — activa el modo agente sin necesidad de ubicación
  const handleConsulta = async (ctx: Context) => {
    if (ctx.chat) selectedByChat.delete(ctx.chat.id);
    await ctx.reply(
      "🤖 Modo agente activado. Escribe tu consulta sobre obras públicas del Perú y Gemma buscará en la BD de INFOBRAS.\n\n" +
        "Ejemplos:\n" +
        "• ¿Qué obras tiene el contratista AESA en Lima?\n" +
        "• Muéstrame obras paralizadas en Cusco\n" +
        "• Dame el detalle del código INFOBRAS 12345\n" +
        "• Busca obras en Av. Arequipa Miraflores",
      { reply_markup: { remove_keyboard: true } },
    );
  };
  bot.command("consulta", handleConsulta);
  bot.command("agente", handleConsulta);

  bot.on("message:location", async (ctx) => {
    try {
      const { latitude, longitude } = ctx.message.location;
      const nearby = findNearbyObras({ latitud: latitude, longitud: longitude }, obras, 3);
      if (nearby.length === 0) {
        await ctx.reply("No encontré obras utilizables en el Excel.");
        return;
      }

      await ctx.reply(
        "Obras tomadas de INFOBRAS. ⚠️ Las distancias son simuladas porque el Excel no contiene coordenadas.",
        { reply_markup: { remove_keyboard: true } },
      );
      for (const { obra, distanciaKm } of nearby) {
        const index = obras.indexOf(obra);
        const keyboard = new InlineKeyboard().text("Ver detalle y analizar", `obra:${index.toString(36)}`);
        await ctx.reply(
          `${obra.nombre}\n` +
            `CUI: ${obra.cui}\n` +
            `Código INFOBRAS: ${obra.codigoInfobras}\n` +
            `Estado: ${obra.estado}\n` +
            `Avance ejecutado: ${obra.avanceEjecutado ?? "No registrado"}%\n` +
            `Avance programado: ${obra.avanceProgramado ?? "No registrado"}%\n` +
            `Distancia simulada: ${distanciaKm.toFixed(1)} km\n\n` +
            `Fuente de los datos: ${obra.fuente}.`,
          { reply_markup: keyboard },
        );
      }
    } catch {
      console.error("No se pudo procesar una ubicación recibida.");
      await ctx.reply("No pude procesar tu ubicación. Inténtalo nuevamente con /start.");
    }
  });

  bot.callbackQuery(/^obra:([0-9a-z]+)$/, async (ctx) => {
    try {
      const index = Number.parseInt(ctx.match[1], 36);
      const obra = obras[index];
      if (!obra) {
        await ctx.answerCallbackQuery({ text: "La obra ya no está disponible." });
        return;
      }

      const chatId = ctx.callbackQuery.message?.chat.id;
      if (chatId === undefined) {
        await ctx.answerCallbackQuery({ text: "No pude identificar este chat." });
        return;
      }
      selectedByChat.set(chatId, index);
      await ctx.answerCallbackQuery();
      await ctx.reply("Gemma está analizando los campos de esta obra en dataset.xlsx…");
      const analisis = await analizarConGemma(datasetObraComoTexto(obra));
      await ctx.reply(
        `${obra.nombre}\n\n` +
          `CUI: ${obra.cui}\n` +
          `Código INFOBRAS: ${obra.codigoInfobras}\n` +
          `Entidad: ${obra.entidad}\n` +
          `Presupuesto: ${obra.presupuesto === null ? "No registrado" : formatCurrency(obra.presupuesto)}\n` +
          `Ubicación: ${obra.distrito}, ${obra.provincia}, ${obra.departamento}\n` +
          `Estado: ${obra.estado}\n` +
          `Días de paralización/retraso: ${obra.diasRetraso ?? "No registrados"}\n` +
          `Causa registrada: ${obra.causa}\n` +
          `Actualización: ${obra.ultimaActualizacion}\n\n` +
          `🤖 Análisis de Gemma:\n${analisis.resumen_ciudadano}\n\n` +
          `Acción pendiente: ${analisis.accion_pendiente}\n` +
          `Evidencia: “${analisis.evidencia_textual}”\n\n` +
          `Fuente: ${obra.fuente}. Las coordenadas son simuladas.\n\n` +
          "Ahora puedes escribir una pregunta sobre esta obra y Gemma responderá solo con información del Excel.",
      );
    } catch (error) {
      console.error("No se pudo analizar el detalle de una obra.");
      await ctx.reply(
        error instanceof Error
          ? `No pude completar el análisis: ${error.message}`
          : "No pude completar el análisis. Inténtalo nuevamente.",
      );
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();

    // Ignorar comandos (ya los maneja grammy aparte)
    if (text.startsWith("/")) return;

    if (text.length > 800) {
      await ctx.reply("La consulta es demasiado larga. Usa un máximo de 800 caracteres.");
      return;
    }

    const index = selectedByChat.get(ctx.chat.id);

    // ── Flujo A: hay una obra seleccionada → preguntas específicas sobre esa obra ──
    if (index !== undefined) {
      if (text.length > 500) {
        await ctx.reply("La pregunta es demasiado larga. Usa un máximo de 500 caracteres.");
        return;
      }
      try {
        await ctx.reply("Gemma está revisando esa pregunta en los datos del Excel…");
        const obra = obras[index];
        const answer = await responderPreguntaConGemma(
          datasetObraComoTexto(obra),
          text,
        );
        await ctx.reply(`${answer}\n\nFuente: ${obra.fuente}.`);
      } catch (error) {
        console.error("Gemma no pudo responder una pregunta sobre la obra.");
        await ctx.reply(
          error instanceof Error ? `No pude responder: ${error.message}` : "No pude responder la pregunta.",
        );
      }
      return;
    }

    // ── Flujo B: sin obra seleccionada → agente ReAct con BD Postgres ──
    try {
      await ctx.reply("🔍 Consultando la base de datos de INFOBRAS…");
      const respuesta = await runReactAgent(text);
      // Telegram limita mensajes a 4096 caracteres
      if (respuesta.length <= 4096) {
        await ctx.reply(respuesta);
      } else {
        // Partir en fragmentos si la respuesta es muy larga
        for (let i = 0; i < respuesta.length; i += 4000) {
          await ctx.reply(respuesta.slice(i, i + 4000));
        }
      }
    } catch (error) {
      console.error("El agente ReAct falló:", error);
      await ctx.reply(
        error instanceof Error
          ? `No pude completar la consulta: ${error.message}`
          : "Ocurrió un error al procesar tu consulta. Inténtalo nuevamente.",
      );
    }
  });

  bot.catch(async (error) => {
    console.error(`Error de Telegram en la actualización ${error.ctx.update.update_id}.`);
    try {
      await error.ctx.reply("Ocurrió un error inesperado. Inténtalo nuevamente con /start.");
    } catch {
      console.error("No fue posible enviar el mensaje de error al usuario.");
    }
  });

  const shutdown = async () => {
    bot.stop();
    await closePool();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  console.log("Vigía Público está iniciando por long polling.");
  await bot.start({ onStart: () => console.log("Vigía Público está listo. Agente ReAct activo.") });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "No se pudo iniciar Vigía Público.");
  process.exitCode = 1;
});
