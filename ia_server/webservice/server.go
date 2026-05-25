package webservice

import (
	"TestNLP/pkg/censorship"
	"TestNLP/pkg/classify"
	"TestNLP/pkg/data_persistence"
	"TestNLP/pkg/dictionnary"
	"TestNLP/pkg/libs"
	"TestNLP/word2vec"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

const (
	// DefaultMistralModel : modèle Mistral utilisé quand `MISTRAL_MODEL` n'est pas
	// défini (cf. design doc §12 Phase 7 — latence + coût minimaux du catalogue).
	DefaultMistralModel = "mistral-small-latest"
	// LLMHTTPTimeout : budget de latence d'un appel Mistral. Le critère §12 vise
	// P95 < 2s ; 30s laisse une marge pour les cold-starts et garantit que le
	// fallback word2vec se déclenche avant que SvelteKit timeout sa requête.
	LLMHTTPTimeout = 30 * time.Second
)

type ServerAgent struct {
	sync.Mutex
	id       string
	addr     string
	Sessions map[string]*censorship.Session
	Saver    *data_persistence.PersistenceHandler
	// Modèle word2vec partagé pour POST /api/classify (cf. design doc §6 / Phase 6).
	// Indépendant des Sessions censorship : `/api/classify` est stateless côté Go
	// (l'état canonique vit en BD SvelteKit). Chargé une fois au boot ; nil si le
	// fichier resources/model.bin est absent → le handler répond alors 503 et le
	// client TS retombe sur le stub.
	ClassifyModel *word2vec.Model
	ClassifyDict  *dictionnary.Dictionnary

	// Phase 7 — config du backend LLM Mistral (cf. design doc §12 Phase 7). Le
	// switch entre `word2vec` et `llm` est interne au handler /api/classify ;
	// l'endpoint reste unique. Si `llm` échoue (key absente, HTTP non-2xx, JSON
	// cassé, timeout), le handler retombe sur word2vec automatiquement.
	ClassifyBackend string       // CLASSIFY_BACKEND : "word2vec" (défaut) | "llm"
	MistralAPIURL   string       // MISTRAL_API_URL : override, défaut classify.MistralEndpoint
	MistralAPIKey   string       // MISTRAL_API_KEY : Bearer token (requis si llm)
	MistralModel    string       // MISTRAL_MODEL : défaut DefaultMistralModel
	HTTPClient      *http.Client // injecté pour testabilité (httptest.Client)
}

func NewServerAgent(addr string) *ServerAgent {
	saver := data_persistence.NewPersistenceHandler("data.json")
	sessionsData, ok, err := saver.LoadSessionData()

	classifyModel, classifyDict := loadClassifyModel()
	llmCfg := loadLLMConfig()

	//si une sauvegarde existe, la charger
	if ok {
		sessions, err := data_persistence.LoadSessions(sessionsData)
		if err != nil {
			fmt.Println("[Warning] Impossible de charger les données de sauvegarde :", err)
		}
		return newAgent(addr, sessions, saver, classifyModel, classifyDict, llmCfg)
	} else {
		if err != nil {
			fmt.Println("[Warning] Fichier de sauvegarde inexistant", err)
		}
		return newAgent(addr, map[string]*censorship.Session{}, saver, classifyModel, classifyDict, llmCfg)
	}

}

type llmConfig struct {
	backend string
	apiURL  string
	apiKey  string
	model   string
}

func loadLLMConfig() llmConfig {
	backend := os.Getenv("CLASSIFY_BACKEND")
	if backend == "" {
		backend = "word2vec"
	}
	apiURL := os.Getenv("MISTRAL_API_URL")
	if apiURL == "" {
		apiURL = classify.MistralEndpoint
	}
	model := os.Getenv("MISTRAL_MODEL")
	if model == "" {
		model = DefaultMistralModel
	}
	apiKey := os.Getenv("MISTRAL_API_KEY")
	if backend == "llm" {
		if apiKey == "" {
			log.Printf("[Warning] CLASSIFY_BACKEND=llm but MISTRAL_API_KEY is empty — /api/classify will fall back to word2vec on every request")
		} else {
			log.Printf("/api/classify LLM backend enabled (model=%s)", model)
		}
	}
	return llmConfig{backend: backend, apiURL: apiURL, apiKey: apiKey, model: model}
}

func newAgent(
	addr string,
	sessions map[string]*censorship.Session,
	saver *data_persistence.PersistenceHandler,
	classifyModel *word2vec.Model,
	classifyDict *dictionnary.Dictionnary,
	llm llmConfig,
) *ServerAgent {
	return &ServerAgent{
		Mutex:           sync.Mutex{},
		id:              addr,
		addr:            addr,
		Sessions:        sessions,
		Saver:           saver,
		ClassifyModel:   classifyModel,
		ClassifyDict:    classifyDict,
		ClassifyBackend: llm.backend,
		MistralAPIURL:   llm.apiURL,
		MistralAPIKey:   llm.apiKey,
		MistralModel:    llm.model,
		HTTPClient:      &http.Client{Timeout: LLMHTTPTimeout},
	}
}

// loadClassifyModel : best-effort. Retourne (nil, nil) si le fichier modèle n'existe
// pas ou s'il est corrompu — le serveur démarre quand même, /api/classify répond
// alors 503. Le path est partagé avec censorship (`libs.Word2vecFilePath`).
func loadClassifyModel() (*word2vec.Model, *dictionnary.Dictionnary) {
	file, err := os.Open(libs.Word2vecFilePath)
	if err != nil {
		log.Printf("[Warning] word2vec model not found at %s: %v — /api/classify will respond 503", libs.Word2vecFilePath, err)
		return nil, nil
	}
	defer file.Close()
	model, err := word2vec.FromReader(io.Reader(file))
	if err != nil {
		log.Printf("[Warning] failed to load word2vec model from %s: %v — /api/classify will respond 503", libs.Word2vecFilePath, err)
		return nil, nil
	}
	dict := dictionnary.NewDictionnary(model)
	log.Printf("word2vec model loaded for /api/classify (vocab size=%d, dim=%d)", model.Size(), model.Dim())
	return model, dict
}

// Test de la méthode
func (rsa *ServerAgent) checkMethod(method string, w http.ResponseWriter, r *http.Request) bool {
	if r.Method != method {
		w.WriteHeader(http.StatusMethodNotAllowed)
		fmt.Fprintf(w, "method %q not allowed", r.Method)
		return false
	}
	return true
}

// do a decoderequest factory
func decodeRequest[Req libs.Request](r *http.Request) (req Req, err error) {
	buf := new(bytes.Buffer)
	buf.ReadFrom(r.Body)
	err = json.Unmarshal(buf.Bytes(), &req)
	return
}

func (rsa *ServerAgent) Start() {
	// création du multiplexer
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/checkMsg", rsa.DoIsCensored)
	mux.HandleFunc("POST /api/newSession", rsa.DoNewSession)
	mux.HandleFunc("POST /api/classify", rsa.DoClassify)
	mux.HandleFunc("GET /api/health", rsa.Health)

	// création du serveur http
	server := &http.Server{
		Addr:           rsa.addr,
		Handler:        mux,
		ReadTimeout:    10 * time.Second,
		WriteTimeout:   10 * time.Second,
		MaxHeaderBytes: 1 << 20}

	// lancement du serveur
	log.Println("IA_Server running on http://localhost" + rsa.addr)
	go log.Fatal(server.ListenAndServe())
}

func (rsa *ServerAgent) Health(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
