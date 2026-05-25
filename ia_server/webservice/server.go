package webservice

import (
	"TestNLP/pkg/censorship"
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
}

func NewServerAgent(addr string) *ServerAgent {
	saver := data_persistence.NewPersistenceHandler("data.json")
	sessionsData, ok, err := saver.LoadSessionData()

	classifyModel, classifyDict := loadClassifyModel()

	//si une sauvegarde existe, la charger
	if ok {
		sessions, err := data_persistence.LoadSessions(sessionsData)
		if err != nil {
			fmt.Println("[Warning] Impossible de charger les données de sauvegarde :", err)
		}
		return &ServerAgent{sync.Mutex{}, addr, addr, sessions, saver, classifyModel, classifyDict}
	} else {
		if err != nil {
			fmt.Println("[Warning] Fichier de sauvegarde inexistant", err)
		}
		return &ServerAgent{sync.Mutex{}, addr, addr, map[string]*censorship.Session{}, saver, classifyModel, classifyDict}
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
