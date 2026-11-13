// Explicit user reviews, not model judgments or globally rejected channels.
// Match the entire catalog artist/channel pair; never reject a channel for
// another artist or infer that an artist has no other YouTube presence.
export const youtubeChannelReviews = [
  ['3551673','14789664','UC_avONjSEW5_1YukNN9ljbg','Artist has no own channel; uploader is not artist-owned'],
  ['3551673','14789664','UCKo7pV29OIMzVOs2LoRkN-g','Artist has no own channel; uploader is not artist-owned'],
  ['3869046','11776202','UCOgASZVYeB6U37pL_8Y1Ofw','ZJSTV uploader is not the artist channel'],
  ['3869046','11776202','UCp8cPvx_Od76EL66vvCnhRA','ZJSTV uploader is not the artist channel'],
  ['3933297','16306244','UC6vWjDzkj0JryCDHKimIKfQ','User-rejected false positive'],
  ['3933297','16306244','UC1yhNRN9qrTmpvCFwfHZ2FA','User-rejected false positive'],
  ['3841420','16170857','UClq3l26d0Q18d9nOb61RC1w','User rejected this uploader as a false positive for Idol House'],
  ['3841420','16170857','UCW8pHCd6SofXNQeEsQWINbg','User identifies this as Idol House Türkiye, not the catalog artist Idol House'],
  ['230803','13873440','UC7yV3NPRjUY3ASN6QHZJfJA','User flagged Blueberry Bridge as a false positive for CHOIJUNSEONG (Jun S); supplied screenshot shows a multi-artist lyrics uploader, not a supported artist channel'],
  ['257398','11498692','UCso2wzxEVKV-f4iC3MJrRzA','User identifies this as LYKN’s group channel; William Jakrapatr is a member, not the channel’s individual artist identity'],
  ['3547423','15907724','UCBmSVAoY-ZSl2Qzz8VMrAWQ','User identifies Zime Media (@ZimemediaAb) as an independent record label distributing Ryan Reed’s music, not Ryan Reed’s own channel'],
  ['3779209','10912450','UCZg2-TZBGrwRbuettVf10uw','User identifies this as BrunuhVille’s channel; Lumina is the title of his instrumental track, not the catalog artist identity'],
  ['3550422','15815816','UCEe3t_MV_Jf8nwvki8H5kOA','User identifies Come To Brasil! as a Brazilian funk music and lyrics channel uploading a lyric video for Gypsy woman in Brazil (Speed) by Médio grave and KEVYANGYUE, not KEVYANGYUE’s own channel'],
  ['290069','10278251','UC6OKD507rK9sKspKnJOpCeA','User disputes Merryattack ownership; saved uploader is Soul Of Hardstyle and the video credits Merryattack as an artist, not as the channel owner. Reject as an artist-channel match; do not infer no music association'],
].map(([profileId,cmArtist,channelId,reason])=>Object.freeze({
  profileId,cmArtist,url:'https://www.youtube.com/channel/'+channelId,
  status:'rejected',source:'user_review',reason,
}));
