use clap::{Parser, Subcommand};

mod schedule;

#[derive(Parser)]
#[command(name = "pico", version, about = "pico command-line interface")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(subcommand)]
    Schedule(schedule::ScheduleCommand),
}

#[tokio::main]
async fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;
    let cli = Cli::parse();
    match cli.command {
        Command::Schedule(cmd) => schedule::run(cmd).await,
    }
}
