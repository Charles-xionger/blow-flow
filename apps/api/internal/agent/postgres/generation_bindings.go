package postgres

import (
	"encoding/json"
	"blow-flow/api/internal/generation"
)

func generationBinding(snapshot []byte,target string)(string,string,bool){return generation.BindingDigest(snapshot,target)}

func hasGenerationResult(snapshot []byte, target string) bool {
	var graph struct { Nodes []struct { ID string `json:"id"`; Data struct { ImageSrc string `json:"imageSrc"`; VideoSrc string `json:"videoSrc"`; OutputArtifacts []json.RawMessage `json:"outputArtifacts"` } `json:"data"` } `json:"nodes"` }
	if json.Unmarshal(snapshot,&graph)!=nil { return false }
	for _,node:=range graph.Nodes { if node.ID==target { return node.Data.ImageSrc!="" || node.Data.VideoSrc!="" || len(node.Data.OutputArtifacts)>0 } }
	return false
}
