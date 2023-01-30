// 
// THIS FILE HAS BEEN GENERATED AUTOMATICALLY
// DO NOT CHANGE IT MANUALLY UNLESS YOU KNOW WHAT YOU'RE DOING
// 
// GENERATED USING @colyseus/schema 1.0.44
// 

using Colyseus.Schema;

public partial class WebRTCSignalingRoomState : Schema {
	[Type(0, "map", typeof(MapSchema<WebRTCPeer>))]
	public MapSchema<WebRTCPeer> players = new MapSchema<WebRTCPeer>();
}

