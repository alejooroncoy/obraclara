/**
 * lib/agent/tools.ts
 *
 * Las 4 herramientas de negocio del agente ReAct.
 * Todas consultan la tabla infobras_raw en Postgres via lib/db.ts.
 * Los nombres de función y parámetros son los que el LLM debe invocar exactamente.
 */

import * as fuzzball from "fuzzball";
import { query } from "../db";

// ─────────────────────────────────────────────────────────────
// Tipos de retorno
// ─────────────────────────────────────────────────────────────

export interface ObraResumida {
  codigo_infobras: string;
  nombre: string;
  estado: string;
  distrito: string;
  provincia: string;
  departamento: string;
  contratista: string | null;
  monto_contrato: number | null;
  avance_ejecutado: number | null;
}

export interface ResultadoBusqueda {
  total_encontrado: number;
  truncado: boolean;
  obras: ObraResumida[];
}

export interface CandidatoDireccion {
  codigo_infobras: string;
  nombre: string;
  direccion: string;
  distrito: string;
  score_similitud: number;
}

export interface DetalleObra {
  codigo_infobras: string;
  codigo_unico_de_inversion: string | null;
  nombre: string;
  entidad: string | null;
  estado: string;
  distrito: string;
  provincia: string;
  departamento: string;
  direccion: string | null;
  contratista: string | null;
  ruc_contratista: string | null;
  monto_contrato: number | null;
  monto_obra_soles: number | null;
  avance_programado: number | null;
  avance_ejecutado: number | null;
  fecha_inicio: string | null;
  fecha_fin_programada: string | null;
  fecha_fin_real: string | null;
  existe_paralizacion: string | null;
  causal_paralizacion: string | null;
  dias_paralizado: number | null;
  n_modificaciones: number | null;
  n_controversias: number | null;
  comentarios: string | null;
}

export interface ObraContratista {
  codigo_infobras: string;
  nombre: string;
  estado: string;
  monto_contrato: number | null;
  avance_ejecutado: number | null;
}

export interface HistorialContratista {
  contratista: string;
  total_obras: number;
  finalizadas: number;
  en_ejecucion: number;
  paralizadas: number;
  score_confianza: number;
  etiqueta_confianza: "Alta confianza" | "Confianza media" | "Baja confianza / historial de riesgo";
  obras: ObraContratista[];
}

// ─────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────

/** Genera los fragmentos SQL de filtros WHERE y sus parámetros */
function buildWhereClause(
  filters: Array<{ col: string; val: string | undefined | null }>,
  startIdx = 1,
): { whereSql: string; params: string[]; nextIdx: number } {
  const conditions: string[] = [];
  const params: string[] = [];
  let idx = startIdx;

  for (const { col, val } of filters) {
    if (val !== undefined && val !== null && val.trim() !== "") {
      conditions.push(`${col} ILIKE $${idx}`);
      params.push(`%${val.trim()}%`);
      idx++;
    }
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { whereSql, params, nextIdx: idx };
}

function calcularScoreConfianza(total: number, finalizadas: number, paralizadas: number): {
  score: number;
  etiqueta: "Alta confianza" | "Confianza media" | "Baja confianza / historial de riesgo";
} {
  if (total === 0) return { score: 50, etiqueta: "Confianza media" };
  const score_raw = (finalizadas - paralizadas * 1.5) / total;
  const score_norm = Math.min(100, Math.max(0, ((score_raw + 1.5) / 2.5) * 100));
  const score = Math.round(score_norm);

  let etiqueta: "Alta confianza" | "Confianza media" | "Baja confianza / historial de riesgo";
  if (score >= 75) etiqueta = "Alta confianza";
  else if (score >= 45) etiqueta = "Confianza media";
  else etiqueta = "Baja confianza / historial de riesgo";

  return { score, etiqueta };
}

// ─────────────────────────────────────────────────────────────
// Herramienta 1 — buscar_obras
// ─────────────────────────────────────────────────────────────

/**
 * Busca obras filtrando por cualquier combinación de campos.
 * Retorna máx. 8 resultados + total_encontrado + truncado.
 */
export async function buscar_obras(args: {
  nombre?: string;
  codigo?: string;
  distrito?: string;
  estado?: string;
  contratista?: string;
}): Promise<ResultadoBusqueda> {
  const { whereSql, params } = buildWhereClause([
    { col: "nombre_de_obra", val: args.nombre },
    { col: "codigo_infobras", val: args.codigo },
    { col: "distrito", val: args.distrito },
    { col: "estado_de_ejecucion", val: args.estado },
    { col: "nombre_o_razon_social_de_la_empresa_o_consorcio", val: args.contratista },
  ]);

  // Primero contamos el total
  const countRows = await query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM infobras_raw ${whereSql}`,
    params,
  );
  const total = parseInt(countRows[0]?.total ?? "0", 10);

  // Luego traemos hasta 8 filas
  const rows = await query<{
    codigo_infobras: string;
    nombre_de_obra: string;
    estado_de_ejecucion: string;
    distrito: string;
    provincia: string;
    departamento: string;
    nombre_o_razon_social_de_la_empresa_o_consorcio: string | null;
    monto_del_contrato_en_soles: number | null;
    avance_fisico_real_acumulado_porcentaje: number | null;
  }>(
    `SELECT
       codigo_infobras,
       nombre_de_obra,
       estado_de_ejecucion,
       distrito,
       provincia,
       departamento,
       nombre_o_razon_social_de_la_empresa_o_consorcio,
       monto_del_contrato_en_soles,
       avance_fisico_real_acumulado_porcentaje
     FROM infobras_raw
     ${whereSql}
     LIMIT 8`,
    params,
  );

  return {
    total_encontrado: total,
    truncado: total > 8,
    obras: rows.map((r) => ({
      codigo_infobras: r.codigo_infobras,
      nombre: r.nombre_de_obra,
      estado: r.estado_de_ejecucion,
      distrito: r.distrito,
      provincia: r.provincia,
      departamento: r.departamento,
      contratista: r.nombre_o_razon_social_de_la_empresa_o_consorcio,
      monto_contrato: r.monto_del_contrato_en_soles,
      avance_ejecutado: r.avance_fisico_real_acumulado_porcentaje,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Herramienta 2 — buscar_por_direccion
// ─────────────────────────────────────────────────────────────

/**
 * Busca obras por dirección usando fuzzy matching (token_sort_ratio).
 * Umbral default: 55. El agente debe advertir al usuario si score < 70.
 */
export async function buscar_por_direccion(args: {
  direccion: string;
  distrito?: string;
}): Promise<CandidatoDireccion[]> {
  const { whereSql, params } = buildWhereClause([
    { col: "distrito", val: args.distrito },
  ]);

  // Traemos todas las direcciones no nulas (máx 5000 para no saturar memoria)
  const rows = await query<{
    codigo_infobras: string;
    nombre_de_obra: string;
    direccion_o_informacion_de_referencia: string;
    distrito: string;
  }>(
    `SELECT
       codigo_infobras,
       nombre_de_obra,
       direccion_o_informacion_de_referencia,
       distrito
     FROM infobras_raw
     ${whereSql}
     AND direccion_o_informacion_de_referencia IS NOT NULL
     AND direccion_o_informacion_de_referencia <> ''
     LIMIT 5000`,
    params,
  );

  const UMBRAL = 55;
  const candidatos: CandidatoDireccion[] = [];

  for (const row of rows) {
    const score: number = fuzzball.token_sort_ratio(
      args.direccion,
      row.direccion_o_informacion_de_referencia,
    );
    if (score >= UMBRAL) {
      candidatos.push({
        codigo_infobras: row.codigo_infobras,
        nombre: row.nombre_de_obra,
        direccion: row.direccion_o_informacion_de_referencia,
        distrito: row.distrito,
        score_similitud: score,
      });
    }
  }

  // Ordenar descendente por score, máx 6 resultados
  candidatos.sort((a, b) => b.score_similitud - a.score_similitud);
  return candidatos.slice(0, 6);
}

// ─────────────────────────────────────────────────────────────
// Herramienta 3 — obtener_detalle_obra
// ─────────────────────────────────────────────────────────────

/**
 * Retorna el detalle completo de una obra por su código INFOBRAS.
 */
export async function obtener_detalle_obra(args: {
  codigo: string;
}): Promise<DetalleObra | null> {
  const rows = await query<{
    codigo_infobras: string;
    codigo_unico_de_inversion: string | null;
    nombre_de_obra: string;
    entidad_publica: string | null;
    estado_de_ejecucion: string;
    distrito: string;
    provincia: string;
    departamento: string;
    direccion_o_informacion_de_referencia: string | null;
    nombre_o_razon_social_de_la_empresa_o_consorcio: string | null;
    ruc_ejecucion: string | null;
    monto_del_contrato_en_soles: number | null;
    costo_de_la_obra_en_soles: number | null;
    avance_fisico_programado_acumulado_porcentaje: number | null;
    avance_fisico_real_acumulado_porcentaje: number | null;
    fecha_de_inicio_de_obra: string | null;
    fecha_finalizacion_programada_de_obra: string | null;
    fecha_de_finalizacion_real: string | null;
    existe_paralizacion: string | null;
    causal_de_paralizacion: string | null;
    numero_de_dias_paralizado: number | null;
    n_de_modificaciones: number | null;
    n_de_controversias: number | null;
    comentarios: string | null;
  }>(
    `SELECT
       codigo_infobras,
       codigo_unico_de_inversion,
       nombre_de_obra,
       entidad_publica,
       estado_de_ejecucion,
       distrito,
       provincia,
       departamento,
       direccion_o_informacion_de_referencia,
       nombre_o_razon_social_de_la_empresa_o_consorcio,
       ruc_ejecucion,
       monto_del_contrato_en_soles,
       costo_de_la_obra_en_soles,
       avance_fisico_programado_acumulado_porcentaje,
       avance_fisico_real_acumulado_porcentaje,
       fecha_de_inicio_de_obra,
       fecha_finalizacion_programada_de_obra,
       fecha_de_finalizacion_real,
       existe_paralizacion,
       causal_de_paralizacion,
       numero_de_dias_paralizado,
       n_de_modificaciones,
       n_de_controversias,
       comentarios
     FROM infobras_raw
     WHERE codigo_infobras = $1
     LIMIT 1`,
    [args.codigo.trim()],
  );

  if (rows.length === 0) return null;
  const r = rows[0];

  return {
    codigo_infobras: r.codigo_infobras,
    codigo_unico_de_inversion: r.codigo_unico_de_inversion,
    nombre: r.nombre_de_obra,
    entidad: r.entidad_publica,
    estado: r.estado_de_ejecucion,
    distrito: r.distrito,
    provincia: r.provincia,
    departamento: r.departamento,
    direccion: r.direccion_o_informacion_de_referencia,
    contratista: r.nombre_o_razon_social_de_la_empresa_o_consorcio,
    ruc_contratista: r.ruc_ejecucion,
    monto_contrato: r.monto_del_contrato_en_soles,
    monto_obra_soles: r.costo_de_la_obra_en_soles,
    avance_programado: r.avance_fisico_programado_acumulado_porcentaje,
    avance_ejecutado: r.avance_fisico_real_acumulado_porcentaje,
    fecha_inicio: r.fecha_de_inicio_de_obra,
    fecha_fin_programada: r.fecha_finalizacion_programada_de_obra,
    fecha_fin_real: r.fecha_de_finalizacion_real,
    existe_paralizacion: r.existe_paralizacion,
    causal_paralizacion: r.causal_de_paralizacion,
    dias_paralizado: r.numero_de_dias_paralizado,
    n_modificaciones: r.n_de_modificaciones,
    n_controversias: r.n_de_controversias,
    comentarios: r.comentarios,
  };
}

// ─────────────────────────────────────────────────────────────
// Herramienta 4 — obtener_historial_contratista
// ─────────────────────────────────────────────────────────────

/**
 * Retorna todas las obras de un contratista + score de confianza.
 * El score se calcula en TypeScript, nunca en el LLM.
 */
export async function obtener_historial_contratista(args: {
  contratista: string;
}): Promise<HistorialContratista> {
  const rows = await query<{
    codigo_infobras: string;
    nombre_de_obra: string;
    estado_de_ejecucion: string;
    monto_del_contrato_en_soles: number | null;
    avance_fisico_real_acumulado_porcentaje: number | null;
  }>(
    `SELECT
       codigo_infobras,
       nombre_de_obra,
       estado_de_ejecucion,
       monto_del_contrato_en_soles,
       avance_fisico_real_acumulado_porcentaje
     FROM infobras_raw
     WHERE nombre_o_razon_social_de_la_empresa_o_consorcio ILIKE $1
     ORDER BY estado_de_ejecucion`,
    [`%${args.contratista.trim()}%`],
  );

  const total = rows.length;
  // Consideramos "Finalizada" y "Liquidada" como estados finalizados;
  // "En Ejecución" como activa; "Paralizada" como paralizada
  const finalizadas = rows.filter(
    (r) =>
      r.estado_de_ejecucion?.toLowerCase().includes("finaliz") ||
      r.estado_de_ejecucion?.toLowerCase().includes("liquidada"),
  ).length;
  const paralizadas = rows.filter((r) =>
    r.estado_de_ejecucion?.toLowerCase().includes("paraliz"),
  ).length;
  const en_ejecucion = rows.filter((r) =>
    r.estado_de_ejecucion?.toLowerCase().includes("ejecuci"),
  ).length;

  const { score, etiqueta } = calcularScoreConfianza(total, finalizadas, paralizadas);

  const MAX_OBRAS_RETORNADAS = 15;
  const obrasCompletas = rows.map((r) => ({
    codigo_infobras: r.codigo_infobras,
    nombre: r.nombre_de_obra,
    estado: r.estado_de_ejecucion,
    monto_contrato: r.monto_del_contrato_en_soles,
    avance_ejecutado: r.avance_fisico_real_acumulado_porcentaje,
  }));

  return {
    contratista: args.contratista,
    total_obras: total,
    finalizadas,
    en_ejecucion,
    paralizadas,
    score_confianza: score,
    etiqueta_confianza: etiqueta,
    obras_truncadas: total > MAX_OBRAS_RETORNADAS,
    obras: obrasCompletas.slice(0, MAX_OBRAS_RETORNADAS),
  };
}
