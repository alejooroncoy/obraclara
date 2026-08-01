import os
import re
import unidecode
import requests
import pandas as pd
from sqlalchemy import create_engine, text
from datetime import datetime

# ==========================================
# CONFIGURACIÓN DE BASE DE DATOS
# ==========================================
# ATENCIÓN: Por seguridad, es mejor usar variables de entorno en lugar de contraseñas en texto plano.
# He configurado esto para que lea la variable DATABASE_URL, y si no existe, use la que me proporcionaste.
DB_URL = os.environ.get(
    "DATABASE_URL", 
    "postgresql://neondb_owner:npg_70axEuKiXsWN@ep-falling-voice-ay298gyd.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
)

# SQLAlchemy a veces requiere que el prefijo sea postgresql:// y no postgres://
if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql://", 1)

URL_OBRAS = "https://infobras.contraloria.gob.pe/InfobrasWeb/Archivo/DownloadFile?filename=DataSet-Obras-Publicas%2001-08-2026&name=DataSet-Obras-Publicas%2001-08-2026&contentType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet&extension=.xlsx"

def descargar_archivo(url, destino):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Iniciando descarga de {url}...")
    response = requests.get(url, stream=True)
    response.raise_for_status() 
    with open(destino, 'wb') as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Descarga completada: {destino}")

def sanitize_name(name):
    name = str(name).replace('.1', '_2')
    name = unidecode.unidecode(name).lower()
    name = re.sub(r'[^a-z0-9_]+', '_', name)
    name = re.sub(r'_+', '_', name).strip('_')
    return name

def procesar_y_guardar(archivo_excel, db_url):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Procesando Excel (header=2)...")
    # header=2 porque los títulos reales están en la 3ra fila (índice 2)
    df = pd.read_excel(archivo_excel, header=2)
    
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Limpiando columnas...")
    clean_cols = []
    seen = set()
    for c in df.columns:
        sc = sanitize_name(c)
        if sc in seen:
            sc = sc + '_2'
        seen.add(sc)
        clean_cols.append(sc)
    df.columns = clean_cols

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Conectando a PostgreSQL...")
    engine = create_engine(db_url)
    
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Vaciando tabla infobras_raw...")
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE infobras_raw"))

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Guardando datos ({len(df)} filas)...")
    df.to_sql('infobras_raw', engine, if_exists='append', index=False, chunksize=1000, method='multi')
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Datos insertados exitosamente.")

if __name__ == "__main__":
    print(f"--- INICIO CRONJOB ETL OBRACLARA (NEON DB): {datetime.now().strftime('%d/%m/%Y %H:%M:%S')} ---")
    
    hoy = datetime.now().strftime("%d-%m-%Y")
    archivo_local_excel = f"/tmp/obras_publicas_{hoy}.xlsx"
    
    try:
        descargar_archivo(URL_OBRAS, archivo_local_excel)
        procesar_y_guardar(archivo_local_excel, DB_URL)
        
        # Limpiar el archivo excel descargado
        if os.path.exists(archivo_local_excel):
            os.remove(archivo_local_excel)
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Archivo temporal eliminado.")
            
        print("--- FIN CRONJOB CORRECTO ---")
        
    except Exception as e:
        print(f"--- ERROR EN CRONJOB: {e} ---")
        raise

