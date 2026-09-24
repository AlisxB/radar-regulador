import os
import sys
import re
import json
import mimetypes
from google import genai
from dotenv import load_dotenv
load_dotenv()

client = genai.Client(api_key=os.environ.get("GENAI_API_KEY"))


def generate_documents_list(genai_client, document_id, worker_dir):
    documents_list = []
    main_doc_mimetype = mimetypes.guess_type(
        os.path.join("/home/assis/hackaton", document_id))
    with open(document_id, "rb") as f:
        uploaded_doc = genai_client.files.upload(
            file=f, config={
                "mime_type": main_doc_mimetype[0],
                "display_name": document_id,
            })
        documents_list.append(uploaded_doc)

    for subdir, dirs, files in os.walk(worker_dir):

        for file in files:
            mimetype = mimetypes.guess_type(os.path.join(subdir, file))
            if mimetype and mimetype[0] == "text/csv":
                file_path = os.path.join(subdir, file)
                with open(file_path, "rb") as f:
                    uploaded_doc = genai_client.files.upload(
                        file=f, config={
                            "mime_type": mimetype[0],
                            "display_name": file_path,
                        })

                    documents_list.append(uploaded_doc)

    return documents_list


def parse_to_dict(raw_input: str, document_id: str) -> dict:
    """Parses input text (JSON block with optional markdown fences or split by ---SEPSEC---)

    into a walkable Python dictionary.
    """
    text = raw_input.strip()

    # 1. Handle '---SEPSEC---' split if present
    if "---SEPSEC---" in text:
        main_body, json_payload = text.split("---SEPSEC---", 1)
        data = {"main_body": main_body.strip()}
        target_json = json_payload.strip()
    else:
        data = {}
        target_json = text

    # 2. Strip markdown code block wrappers (```json ... ```)
    target_json = re.sub(
        r"^```(?:json)?\s*", "", target_json, flags=re.IGNORECASE
    )
    target_json = re.sub(r"\s*```$", "", target_json).strip()

    # 3. Deserialize JSON string into a native dict structure
    parsed_json = json.loads(target_json)

    # 4. Merge results
    if data:
        data.update(parsed_json)
        return data
    parsed_json['document_id'] = document_id

    return parsed_json


def append_to_json_file(data: dict, output_filepath: str) -> None:
    """Appends a dictionary data point to a JSON array stored in a file.

    Creates the file if it does not exist or handles resetting invalid JSON.
    """
    records = []

    # Read existing file if present and non-empty
    if os.path.exists(output_filepath) and os.path.getsize(output_filepath) > 0:
        try:
            with open(output_filepath, "r", encoding="utf-8") as f:
                existing_data = json.load(f)

                if isinstance(existing_data, list):
                    records = existing_data
                else:
                    # Convert single legacy dictionary to list if necessary
                    records = [existing_data]
        except json.JSONDecodeError:
            records = []

    # Append new data point
    records.append(data)

    # Overwrite file with updated list
    with open(output_filepath, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def proccess_document_ids():
    for subdir, dirs, files in os.walk("/home/assis/hackaton"):
        for file in files:
            mimetype = mimetypes.guess_type(os.path.join(subdir, file))
            if mimetype and mimetype[0] == "application/pdf":
                documents_list = generate_documents_list(
                    client, file, "/home/assis/hackaton/")
                print(documents_list)

                for i, document in enumerate(documents_list):
                    documents_list[i] = {"type": "document",
                                         "uri": document.uri, "mime_type": document.mime_type}

                documents_list.append({"type": "text", "text": "Create a detailed log using the base information and extracted/searched auxilary data from the internet focused on the correlation between the csv data and the main document from Portal da Uniao, summarizing the impact of the latter on the energy sector on Brazil using the former as a finantial guideline to anchor statistics alongside search results. Focus on gathering context around laws, entities related to the main document, and gathering heavy amounts of finantial and statistical data that can possibly be affected by the normative legislative effects of that document's excerpt. If there is no finantial impact (document is too loose context, is just a warning about changes in the workforce, etc), explicitly tell it in your log, but find other changes."})
                documents_list.append({"type": "text", "text":
                                       """system_instruction": "You should structure your output in the way described following forward. If the output is not structured in this way, it's NOT valid for usage.
                                        Format (JSON on text):
                                            {
                                              "document_name": "<Str> Official title, type, and number of the document (e.g., 'Portaria MME nº 123/2026'). If not explicitly titled, construct a standardized name.",
                                              "orgao_emissor": "<Str> Issuing body, authority, or publishing vehicle (e.g., 'ANEEL', 'MME', 'DOU').",
                                              "classification": "<Str> Legal or administrative category of the document (e.g., 'Portaria', 'Despacho', 'Resolução Normativa', 'Consulta Pública').",
                                              "grau_urgencia": "<Str> Urgency level of the requirements or impacts. Allowed values: 'baixa', 'moderada', 'alta', 'crítica'.",
                                              "relevance_score": "<Float> Numerical relevance score from 0.00 to 1.00 indicating the importance of the text to the sector.",
                                              "is_relevant": "<Boolean> True if the document content is actionable or highly relevant to the domain; False otherwise.",
                                              "aplicavel_renovaveis": "<Boolean> True if the regulatory or technical content directly impacts renewable energy sources; False otherwise.",
                                              "summary": "<Str> Concise, factual summary (3-6 sentences) detailing the main decision, directive, or announcement without commentary.",
                                              "prazos_acao": [
                                                {
                                                  "has_deadline": "<Boolean> True if a specific deadline or actionable timeframe is mandated in the text; False otherwise.",
                                                  "deadline_date": "<Str|Null> Target date in 'YYYY-MM-DD' ISO format calculated from the text context, or null if non-applicable or generic.",
                                                  "action_required": "<Str> Clear, mandatory task or step required from market agents or institutions before or by the deadline."
                                                }
                                              ],
                                              "financial_impact": {
                                                "direction": "<Str> Directional economic effect. Allowed values: 'Positivo', 'Negativo', 'Neutro', 'Incerteza/Indeterminado'.",
                                                "magnitude": "<Str> Scale of estimated monetary or operational impact. Allowed values: 'Nulo', 'Baixo', 'Médio', 'Alto'.",
                                                "justification": "<Str> Explicit technical or economic reasoning for the assigned direction and magnitude. Inform already available impact and future predictions."
                                              }
                                            }
                                        """
                                       })

                response = client.interactions.create(
                    model="gemini-3.6-flash",
                    input=documents_list,
                    tools=[{"type": "google_search"}],
                )

                json_data = parse_to_dict(response.output_text, file)
                json_data["sources"] = {}
                for step in response.steps:
                    if step.type == "model_output":
                        for content_block in step.content:
                            if content_block.type == "text":
                                if content_block.annotations:
                                    for annotation in content_block.annotations:
                                        if annotation.type == "url_citation":
                                            json_data['sources']["" +
                                                                 annotation.title] = annotation.url
                append_to_json_file(json_data, 'output.json')


proccess_document_ids()
