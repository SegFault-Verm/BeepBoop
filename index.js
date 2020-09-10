const fetch = require('node-fetch')
const Discord = require('discord.js')
const secrets = require('./secrets.js')
const client = new Discord.Client()

const config = {
  prefix: '?',
  redditDepth: 15
}
const channelSources = {}
const redditCache = {}
let reacting = false

const timeout = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const recursiveRedditCache = async (subreddit, results, count, after = null) => {
  if (count === 0) {
    return results
  }
  console.log(`Refreshing ${subreddit} cache: ${count} remaining.`)
  const link = `https://www.reddit.com/r/${subreddit}.json?sort=top&t=all&limit=100${after ? `&after=${after}` : ''}`
  const fetchPage = await fetch(link).then(r => r.json()).catch(console.log)
  if (count === config.redditDepth && (!fetchPage.data || !fetchPage.data.children || !fetchPage.data.children.length)) return { error: { code: 1, msg: 'Subreddit is empty.' } }
  fetchPage.data.children.forEach(child => {
    const d = child.data

    const vidurl = d.preview && d.preview.reddit_video_preview ? d.preview && d.preview.reddit_video_preview.fallback_url : null
    if (!vidurl && !d.url) return
    if (!/\.[A-Za-z0-9]+$/gm.test(d.url)) return

    results.push({
      thumb: d.thumbnail,
      permalink: `https://reddit.com/${d.permalink}`,
      url: d.url,
      vidurl: d.preview && d.preview.reddit_video_preview ? d.preview && d.preview.reddit_video_preview.fallback_url : null,
      title: d.title,
      subreddit: d.subreddit_name_prefixed
    })
  })
  await timeout(1000)
  return recursiveRedditCache(subreddit, results, count - 1, fetchPage.after)
}

const genRedditCache = async (subreddit) => {
  return new Promise((resolve, reject) => {
    if (redditCache[subreddit] && (Date.now() - redditCache[subreddit].lastRefresh) < 10 * 60 * 1000) { // Cache is newer than 10 minutes.
      resolve(redditCache)
    } else {
      recursiveRedditCache(subreddit, [], config.redditDepth).then(images => {
        if (images.error) return reject(subreddit)
        redditCache[subreddit] = { images: images, lastRefresh: Date.now() }
        resolve(redditCache)
      })
    }
  })
}

const genRedditCaches = async (subreddits, invalidSubs = []) => {
  const getResults = await genRedditCache(subreddits[0]).catch(error => invalidSubs.push(error))
  if (subreddits.length > 1) {
    return genRedditCaches(subreddits.slice(1, subreddits.length), invalidSubs)
  } else {
    return { results: getResults, invalidSubs }
  }
}

const performReacts = async (msg) => {
  if (msg) {
    try {
      await msg.react('🔄')
      await msg.react('✅')
      await msg.react('❌')
    } catch (e) { console.log(e) }
  }
}
const sendImages = (guild, channel, existingmsg = null) => {
  const cName = `${guild}_${channel}`
  if (!channelSources[cName]) return

  const subs = [...channelSources[cName].reddit.tags]
  const pickSub = redditCache[subs[Math.floor(Math.random() * subs.length)]]
  if (!pickSub) return
  const pickSubImages = pickSub.images
  const pickImage = pickSubImages[Math.floor(Math.random() * pickSubImages.length)]

  const embed = new Discord.MessageEmbed()
    .setTitle(pickImage.title)
    .setDescription(pickImage.subreddit)
    .setURL(pickImage.permalink)
    .setImage(pickImage.url)

  let result = ''
  if (pickImage.vidurl) {
    result = `${pickImage.permalink}\n${pickImage.vidurl}`
  } else {
    result = embed
  }

  if (!existingmsg) {
    client.guilds.cache.get(guild).channels.cache.get(channel).send(result).then(performReacts)
  } else {
    existingmsg.edit(result).then(performReacts)
  }
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`)
})

client.on('message', async (msg) => {
  if (!msg.cleanContent.indexOf(config.prefix) === 0) return
  const args = msg.cleanContent.substring(1).split(' ')
  if (!args || !args[0]) return
  const command = args[0]

  if (msg.member && (msg.member.hasPermission('KICK_MEMBERS') || msg.author === client.user || msg.author.id === '279302698334027777')) {
    const channelName = `${msg.guild.id}_${msg.channel.id}`

    if (command === 'ping') msg.reply('pong')

    if (command === 'prefix' && args[1]) {
      config.prefix = args[1]
      msg.reply(`The new prefix is: \`${args[1]}\``)
    }

    if (command === 'addsub' || command === 'addsubs') {
      const additions = args.slice(1, args.length)

      if (channelSources[channelName]) {
        additions.forEach(addition => channelSources[channelName].reddit.tags.add(addition))
      } else {
        channelSources[channelName] = {
          reddit: { tags: new Set(...[additions]) }
        }
      }
      const pendingmsg = await msg.reply(`Attempting to fetch images from the following subreddit(s): \`${JSON.stringify(additions).replace(/["[\]/]/g, '').replace(/,/g, ', ')}\`.`)

      genRedditCaches(additions).then(results => {
        if (results.invalidSubs.length) {
          let failString = 'The following subs do not exist, or are empty: `'
          results.invalidSubs.forEach((result, i) => {
            channelSources[channelName].reddit.tags.delete(result)
            failString += `${result}${i === results.invalidSubs.length - 1 ? '`.' : ', '}`
          })
          pendingmsg.edit(`${failString}${additions.length > results.invalidSubs.length
                        ? ` The remaining have been added: \`${JSON.stringify(additions.filter(a => !results.invalidSubs.includes(a))).replace(/["[\]/]/g, '').replace(/,/g, ', ')}\``
                        : ''}`)
        } else {
          pendingmsg.edit(pendingmsg.content.replace('Attempting to fetch', 'Successfully fetched'))
        }
        pendingmsg.channel.send(`${config.prefix}start`)
      })
    }
    if (command === 'listsubs') {
      if (!channelSources[channelName]) {
        msg.reply(`This channel currenly has no media sources. Use \`${config.prefix}addsubs sub1 sub2 sub3\` to get started.`)
      } else {
        msg.reply(`Current subreddits: \`${JSON.stringify([...channelSources[channelName].reddit.tags].reverse()).replace(/["[\]/]/g, '').replace(/,/g, ', ')}\`.`)
      }
    }

    if (command === 'removesub') {
      if (!channelSources[channelName]) {
        msg.reply('This channel doesn\'t have any subreddits.')
      } else {
        const sub = args[1]
        if (channelSources[channelName].reddit.tags.has(sub)) {
          channelSources[channelName].reddit.tags.delete(sub)
          msg.reply(`Current subreddits: \`${JSON.stringify([...channelSources[channelName].reddit.tags].reverse()).replace(/["[\]/]/g, '').replace(/,/g, ', ')}\`.`)
        } else {
          msg.reply('That isn\'t listed as one of this channels subreddits.')
        }
      }
    }

    if (command === 'start') {
      sendImages(msg.guild.id, msg.channel.id)
    }

    if (command === 'debug') reacting = false

    if (command === 'stats') {
      const allSubs = channelSources[channelName]
      if (!allSubs) { msg.reply('There are no cached images in this channel'); return }
      const cacheForSubs = Object.entries(redditCache).filter(entry => [...allSubs.reddit.tags].includes(entry[0])).map(result => result[1].images.length)
      let count = 0
      cacheForSubs.forEach(sub => { count += sub; return true })

      msg.reply(`There are a total of ${count} cached images to choose from in this channel.`)
    }
  }
})

client.on('messageReactionAdd', (reaction, user) => {
  if (user === client.user) return
  if (reaction.message.author !== client.user) return
  if (reacting) {
    reaction.users.remove(user.id)
    return
  }
  reacting = true
  if (reaction.emoji.name === '❌') reaction.message.delete()
  if (reaction.emoji.name === '✅') sendImages(reaction.message.guild.id, reaction.message.channel.id); reaction.message.reactions.removeAll()
  if (reaction.emoji.name === '🔄') sendImages(reaction.message.guild.id, reaction.message.channel.id, reaction.message)
  setTimeout(() => { reacting = false }, 2100)
})

client.login(secrets.token)
