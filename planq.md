# Planq RAG Pipeline (Open-Source/Free Prototype)

## Objective
Build a resilient Retrieval-Augmented Generation (RAG) pipeline for Planq that can handle different drawing formats and reliably return building code violations and citations using open-source and free models.

## Tech Stack
- Next.js
- Supabase (pgvector)
- Hugging Face Transformers (BERT, RoBERTa)
- Tesseract OCR
- OpenAI CLIP (open-source version)

## Implementation Steps

### 1. File Ingestion
- Support multiple file formats (PDF, PNG, JPEG, TIFF)
- Use open-source libraries for each format (pdf2image, Pillow)
- Implement error handling and fallbacks for unsupported or corrupted files

### 2. Image Preprocessing
- Resize and normalize images to a consistent size and format
- Apply image enhancement techniques (contrast adjustment, noise reduction)
- Implement checks to ensure image quality is sufficient for OCR and analysis

### 3. Text Extraction (OCR)
- Use Tesseract OCR (open-source) for text extraction
- Implement error handling for OCR failures or no text returned
- Consider using multiple open-source OCR engines and combining their results

### 4. Text Preprocessing
- Clean and normalize the extracted text (remove special characters, lowercase)
- Tokenize the text into meaningful chunks (sentences, paragraphs)
- Implement checks for sufficient text quality and quantity

### 5. Embedding and Indexing
- Use Hugging Face Transformers (BERT, RoBERTa) for text embedding
- Implement error handling for embedding failures or no results
- Use Supabase pgvector for efficient vector similarity search
- Implement a fallback search mechanism (keyword-based)

### 6. Building Code Retrieval
- Preprocess and embed building code chunks offline using Hugging Face Transformers
- Implement a scoring mechanism to rank retrieved code chunks
- Consider using multiple retrieval methods (vector similarity, keyword matching)

### 7. Violation Detection
- Use Hugging Face Transformers (BERT, RoBERTa) to compare extracted text with retrieved code chunks
- Fine-tune the models on a dataset of building code violations and citations
- Implement prompts to guide the model in identifying violations and citations
- Implement error handling for cases where no violations or citations are found

### 8. Result Aggregation and Presentation
- Aggregate detected violations and citations from multiple pages/images
- Implement a clear and structured format for presenting results (JSON)
- Include metadata like page numbers, confidence scores, and relevant image regions
- Implement error handling for cases where no violations or citations are found

### 9. Testing and Monitoring
- Develop a comprehensive test suite covering various scenarios and edge cases
- Implement logging and monitoring to track system performance and identify issues
- Set up alerts and notifications for critical failures or anomalies
- Regularly review and update the system based on user feedback and requirements

## Notes
- Use open-source and free models and libraries for the prototype
- Break down the implementation into smaller, manageable tasks
- Test thoroughly at each stage
- Continuously iterate and improve the system based on real-world usage and feedback
- Ensure robust error handling, fallbacks, and monitoring for a resilient pipeline
- Consider transitioning to more advanced models (e.g., Anthropic API) in the future

