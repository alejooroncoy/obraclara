import pandas as pd
import unidecode
import re
import os
import requests

URL_OBRAS = "https://infobras.contraloria.gob.pe/InfobrasWeb/Archivo/DownloadFile?filename=DataSet-Obras-Publicas%2001-08-2026&name=DataSet-Obras-Publicas%2001-08-2026&contentType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet&extension=.xlsx"
archivo_excel = "/Users/usuario/Desktop/HACKATON GOOGLE/ETL/obras_publicas.xlsx"
archivo_csv = "/Users/usuario/Desktop/HACKATON GOOGLE/ETL/infobras_raw.csv"

def sanitize_name(name):
    name = str(name).replace('.1', '_2')
    name = unidecode.unidecode(name).lower()
    name = re.sub(r'[^a-z0-9_]+', '_', name)
    name = re.sub(r'_+', '_', name).strip('_')
    return name

if not os.path.exists(archivo_excel):
    print("Descargando el archivo Excel... (puede tomar un momento)")
    response = requests.get(URL_OBRAS, stream=True)
    response.raise_for_status() 
    with open(archivo_excel, 'wb') as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
    print("Descarga completada.")

if os.path.exists(archivo_excel):
    print("Leyendo Excel... (esto puede tomar un minuto)")
    df = pd.read_excel(archivo_excel, header=2)
    
    print("Limpiando columnas...")
    clean_cols = []
    seen = set()
    for c in df.columns:
        sc = sanitize_name(c)
        if sc in seen:
            sc = sc + '_2'
        seen.add(sc)
        clean_cols.append(sc)
    df.columns = clean_cols
    
    print("Escribiendo archivo CSV...")
    df.to_csv(archivo_csv, index=False, encoding='utf-8')
    print(f"Éxito: {archivo_csv}")
else:
    print("Error: No se encontró el archivo Excel.")
